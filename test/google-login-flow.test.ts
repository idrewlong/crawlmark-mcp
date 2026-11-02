import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAUTH_SCOPES } from "../src/lib/google-auth.js";
import { loopbackLogin } from "../src/providers/google-login.js";
import { readTokenFile } from "../src/lib/token-store.js";
import { CrawlmarkOAuth2Client } from "../src/providers/google-oauth-client.js";
import { startFakeGoogle, type FakeGoogle } from "./helpers/fake-google.js";
import { POSIX_MODES } from "./platform.js";
import { cliHint, cliRe } from "./helpers/cli-hint.js";

// The login flow talks to whatever endpoints its OAuth client has. Point that client at the fake Google
// (no production change: the client takes its endpoints as a constructor option).
const hoisted = vi.hoisted(() => ({ endpoints: undefined as Record<string, string> | undefined }));
vi.mock("../src/providers/google.js", () => ({
  newOAuthClient: (redirectUri?: string) =>
    new CrawlmarkOAuth2Client({ clientId: "test-client", clientSecret: "test-secret", redirectUri, endpoints: hoisted.endpoints }),
}));

let google: FakeGoogle;
let dir: string;
let tokenFile: string;

beforeEach(async () => {
  google = await startFakeGoogle();
  hoisted.endpoints = google.endpoints;
  dir = mkdtempSync(join(tmpdir(), "crawlmark-login-"));
  tokenFile = join(dir, "data", "google-token.json");
});

afterEach(async () => {
  await google.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Start the login (no browser) and wait until it has printed the consent URL. */
async function startLogin(timeoutMs = 10_000) {
  const lines: string[] = [];
  let seen!: (url: string) => void;
  const urlSeen = new Promise<string>((r) => (seen = r));
  const login = loopbackLogin({
    tokenFile,
    openBrowser: false,
    timeoutMs,
    log: (l) => {
      lines.push(l);
      if (l.startsWith("http://")) seen(l);
    },
  });
  // Don't let a rejection that happens before the test awaits it count as unhandled.
  login.catch(() => {});
  const authUrl = new URL(await urlSeen);
  const redirectUri = authUrl.searchParams.get("redirect_uri")!;
  const state = authUrl.searchParams.get("state")!;
  return { login, lines, authUrl, redirectUri, state };
}

/** Play the browser: GET the consent URL at the fake Google, follow its redirect to our loopback server. */
async function approve(authUrl: URL): Promise<Response> {
  const hop = await fetch(authUrl, { redirect: "manual" });
  expect(hop.status).toBe(302);
  return fetch(hop.headers.get("location")!);
}

describe("loopback login against a fake Google", () => {
  it("happy path: saves the token (0600, atomically) and reads read-only scopes only", async () => {
    const { login, authUrl, redirectUri } = await startLogin();
    expect(new URL(redirectUri).hostname).toBe("127.0.0.1");

    const page = await approve(authUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Signed in to crawlmark");

    const result = await login;
    expect(result.email).toBe("signed-in@example.com");
    expect(result.missingScopes).toEqual([]);
    expect(result.scopes).toContain("https://www.googleapis.com/auth/webmasters.readonly");

    const stored = readTokenFile(tokenFile)!;
    expect(stored.refresh_token).toBe("fake-refresh-token");
    expect(stored.access_token).toBe("fake-access-token");
    expect(stored.email).toBe("signed-in@example.com");
    if (POSIX_MODES) expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    // The atomic write renames its temp file over the target: nothing else is left in the folder.
    expect(readdirSync(join(dir, "data"))).toEqual(["google-token.json"]);

    // Scopes asked for are read-only (plus openid/email to learn the account), and nothing else.
    const asked = authUrl.searchParams.get("scope")!.split(" ");
    expect(asked.sort()).toEqual([...OAUTH_SCOPES].sort());
    for (const s of asked) expect(s).toMatch(/\.readonly$|^openid$|^email$/);
    for (const s of stored.scope!.split(" ")) expect(s).toMatch(/\.readonly$|^openid$|^email$/);
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("include_granted_scopes")).toBe("false");
  });

  it("uses a 32-byte random state and a fresh one per login", async () => {
    const a = await startLogin();
    expect(Buffer.from(a.state, "base64url")).toHaveLength(32);
    await approve(a.authUrl);
    await a.login;
    const b = await startLogin();
    expect(b.state).not.toBe(a.state);
    await approve(b.authUrl);
    await b.login;
  });

  it("sends a PKCE verifier to the token endpoint that matches the S256 challenge in the consent URL", async () => {
    const { login, authUrl, redirectUri } = await startLogin();
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = authUrl.searchParams.get("code_challenge")!;
    await approve(authUrl);
    await login;

    expect(google.tokenRequests).toHaveLength(1);
    const p = google.tokenRequests[0]!.params;
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("code")).toBe("fake-auth-code");
    expect(p.get("redirect_uri")).toBe(redirectUri);
    expect(p.get("client_id")).toBe("test-client");
    const verifier = p.get("code_verifier")!;
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
  });

  it("refuses a callback with the wrong state, and keeps waiting for the real one", async () => {
    const { login, authUrl, redirectUri } = await startLogin();
    const bad = await fetch(`${redirectUri}?code=evil-code&state=not-the-state`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Invalid or stale sign-in link");
    expect(google.tokenRequests).toHaveLength(0);

    await approve(authUrl);
    await expect(login).resolves.toMatchObject({ email: "signed-in@example.com" });
    // Only the genuine code was ever exchanged.
    expect(google.tokenRequests.map((t) => t.params.get("code"))).toEqual(["fake-auth-code"]);
  });

  it("refuses a callback with no state, and a denial that doesn't carry our state can't cancel the login", async () => {
    const { login, authUrl, redirectUri } = await startLogin();
    expect((await fetch(`${redirectUri}?code=evil-code`)).status).toBe(400);
    expect((await fetch(`${redirectUri}?error=access_denied`)).status).toBe(400);
    expect((await fetch(`${redirectUri.replace("/oauth2callback", "/favicon.ico")}`)).status).toBe(404);
    await approve(authUrl);
    await expect(login).resolves.toBeDefined();
    expect(google.tokenRequests).toHaveLength(1);
  });

  it("a callback after the login finished is refused (the server is closed), never exchanged", async () => {
    const { login, authUrl, redirectUri, state } = await startLogin();
    await approve(authUrl);
    await login;
    // The loopback server is closed once the login finishes.
    await expect(fetch(`${redirectUri}?code=again&state=${state}`)).rejects.toThrow();
    expect(google.tokenRequests).toHaveLength(1);
  });

  it("access_denied from the consent screen gives a clear error, writes no token, and closes the server", async () => {
    const { login, redirectUri, state } = await startLogin();
    const page = await fetch(`${redirectUri}?error=access_denied&state=${state}`);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("Sign-in failed");
    await expect(login).rejects.toThrow("Sign-in was cancelled or access was denied.");
    expect(existsSync(tokenFile)).toBe(false);
    expect(google.tokenRequests).toHaveLength(0);
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("another Google error is passed on by name", async () => {
    const { login, redirectUri, state } = await startLogin();
    await fetch(`${redirectUri}?error=server_error&state=${state}`);
    await expect(login).rejects.toThrow("Google returned an error: server_error.");
  });

  it("a callback with our state but no code is an error", async () => {
    const { login, redirectUri, state } = await startLogin();
    await fetch(`${redirectUri}?state=${state}`);
    await expect(login).rejects.toThrow("no authorization code");
  });

  it("the token endpoint answering 400 invalid_grant fails the login without writing a token", async () => {
    google.plan.token = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } });
    const { login, authUrl } = await startLogin();
    await approve(authUrl);
    await expect(login).rejects.toThrow(new RegExp(`Sign-in failed: Google rejected the authorization code \\(invalid_grant\\)\\..*${cliRe("auth login").source}`));
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("a rejected client (invalid_client) points at the client ID and secret", async () => {
    google.plan.token = () => ({ status: 401, body: { error: "invalid_client" } });
    const { login, authUrl } = await startLogin();
    await approve(authUrl);
    await expect(login).rejects.toThrow(/invalid_client.*GOOGLE_OAUTH_CLIENT_ID/);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("a token response without a refresh token is refused", async () => {
    google.plan.token = () => ({ status: 200, body: { access_token: "a", scope: "openid", expires_in: 3600, token_type: "Bearer" } });
    const { login, authUrl } = await startLogin();
    await approve(authUrl);
    await expect(login).rejects.toThrow("did not return a refresh token");
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("reports data scopes the user unticked on the consent screen", async () => {
    google.plan.token = () => ({
      status: 200,
      body: { access_token: "a", refresh_token: "r", scope: "https://www.googleapis.com/auth/webmasters.readonly openid", expires_in: 3600, token_type: "Bearer" },
    });
    const { login, authUrl } = await startLogin();
    await approve(authUrl);
    const result = await login;
    expect(result.missingScopes).toEqual(["https://www.googleapis.com/auth/analytics.readonly"]);
    expect(readTokenFile(tokenFile)).toBeDefined();
  });

  it("times out when the browser never comes back, and closes the server", async () => {
    const { login, redirectUri } = await startLogin(60);
    await expect(login).rejects.toThrow(/Timed out after \d+s waiting for the browser sign-in/);
    expect(existsSync(tokenFile)).toBe(false);
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("prints the consent URL as a fallback and never launches a browser when openBrowser is false", async () => {
    const { login, lines, authUrl } = await startLogin();
    expect(lines[0]).toMatch(/Opening your browser/);
    expect(lines).toContain(authUrl.toString());
    await approve(authUrl);
    await login;
  });
});
