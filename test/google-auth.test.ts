import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "googleapis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authModeNote,
  describeAuthMode,
  GOOGLE_NOT_CONFIGURED_MESSAGE,
  GoogleNotConfiguredError,
  resolveAuthMode,
  authIdentityKey,
  authUrlOptions,
  CALLBACK_PATH,
  describeAuthStatus,
  emailFromIdToken,
  invalidGrantMessage,
  loginExchangeErrorMessage,
  isInvalidGrant,
  mapTokenError,
  mergeTokens,
  missingDataScopes,
  missingGtmScope,
  GTM_SCOPE,
  DATA_SCOPES,
  OAUTH_SCOPES,
  parseCallback,
  parseTokenFile,
  selectGoogleAuthConfig,
  serviceAccountKeyMissingMessage,
} from "../src/lib/google-auth.js";
import { deleteTokenFile, readTokenFile, writeTokenFile } from "../src/lib/token-store.js";
import { createOAuthClientLoader, CrawlmarkOAuth2Client } from "../src/providers/google-oauth-client.js";
import { POSIX_MODES } from "./platform.js";
import { cliHint, cliRe } from "./helpers/cli-hint.js";

const idToken = (claims: object) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("selectGoogleAuthConfig", () => {
  it("returns oauth config when both client vars are set", () => {
    expect(
      selectGoogleAuthConfig({ GOOGLE_AUTH_MODE: "oauth", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s" }),
    ).toEqual({ mode: "oauth", clientId: "id", clientSecret: "s" });
  });

  it("names every missing oauth var", () => {
    expect(() => selectGoogleAuthConfig({ GOOGLE_AUTH_MODE: "oauth" })).toThrow(
      /GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not set/,
    );
    expect(() => selectGoogleAuthConfig({ GOOGLE_AUTH_MODE: "oauth", GOOGLE_OAUTH_CLIENT_ID: "id" })).toThrow(
      new RegExp(`: GOOGLE_OAUTH_CLIENT_SECRET is not set.*${cliRe("auth login").source}`),
    );
  });

  it("ignores the service-account key in oauth mode, and oauth vars in service_account mode", () => {
    const all = {
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "s",
      GOOGLE_APPLICATION_CREDENTIALS: "/k.json",
    };
    expect(selectGoogleAuthConfig({ GOOGLE_AUTH_MODE: "service_account", ...all })).toEqual({
      mode: "service_account",
      keyFile: "/k.json",
    });
    expect(selectGoogleAuthConfig({ GOOGLE_AUTH_MODE: "oauth", ...all })).toEqual({
      mode: "oauth",
      clientId: "id",
      clientSecret: "s",
    });
    // A key file doesn't stand in for missing OAuth vars.
    expect(() =>
      selectGoogleAuthConfig({ GOOGLE_AUTH_MODE: "oauth", GOOGLE_APPLICATION_CREDENTIALS: "/k.json" }),
    ).toThrow(/GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not set/);
  });

  it("requires GOOGLE_APPLICATION_CREDENTIALS in service_account mode", () => {
    expect(() => selectGoogleAuthConfig({ GOOGLE_AUTH_MODE: "service_account" })).toThrow(
      /GOOGLE_APPLICATION_CREDENTIALS is not set/,
    );
  });

  it("names the resolved key path when the key file is missing", () => {
    expect(serviceAccountKeyMissingMessage("/opt/app/secrets/sa.json")).toContain("/opt/app/secrets/sa.json");
  });
});

describe("auth URL", () => {
  it("requests offline access, forced consent, PKCE S256, state and the read-only scopes", () => {
    const client = new Auth.OAuth2Client({ clientId: "cid.apps.googleusercontent.com", clientSecret: "x" });
    const redirectUri = `http://127.0.0.1:53682${CALLBACK_PATH}`;
    const url = new URL(
      client.generateAuthUrl({
        ...authUrlOptions({ redirectUri, state: "st4te", codeChallenge: "chal" }),
        code_challenge_method: Auth.CodeChallengeMethod.S256,
      }),
    );
    const q = url.searchParams;
    expect(url.origin).toBe("https://accounts.google.com");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("state")).toBe("st4te");
    expect(q.get("redirect_uri")).toBe(redirectUri);
    expect(q.get("code_challenge")).toBe("chal");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")!.split(" ")).toEqual([...OAUTH_SCOPES]);
    expect(q.get("scope")).toContain("tagmanager.readonly");
    expect(q.get("scope")).not.toMatch(/\.edit|\.write|readwrite|tagmanager\.(edit|manage|publish|delete)/);
  });
});

describe("parseCallback", () => {
  it("returns the code when state matches", () => {
    expect(parseCallback(`${CALLBACK_PATH}?state=abc&code=4%2F0xyz&scope=x`, "abc")).toEqual({
      kind: "code",
      code: "4/0xyz",
    });
  });

  it("rejects (without settling) a wrong or missing state, even with a code or error", () => {
    expect(parseCallback(`${CALLBACK_PATH}?state=evil&code=c`, "abc")).toEqual({ kind: "reject" });
    expect(parseCallback(`${CALLBACK_PATH}?code=c`, "abc")).toEqual({ kind: "reject" });
    expect(parseCallback(`${CALLBACK_PATH}?state=evil&error=access_denied`, "abc")).toEqual({ kind: "reject" });
    expect(parseCallback(`${CALLBACK_PATH}?state=`, "abc")).toEqual({ kind: "reject" });
  });

  it("ignores request targets that aren't valid URLs instead of throwing", () => {
    expect(() => parseCallback("http://[", "abc")).not.toThrow();
    expect(parseCallback("http://[", "abc")).toEqual({ kind: "ignore" });
    expect(parseCallback("//[::1", "abc")).toEqual({ kind: "ignore" });
  });

  it("reports access_denied and other provider errors", () => {
    expect(parseCallback(`${CALLBACK_PATH}?state=abc&error=access_denied`, "abc")).toEqual({
      kind: "error",
      message: "Sign-in was cancelled or access was denied.",
    });
    expect(parseCallback(`${CALLBACK_PATH}?state=abc&error=server_error`, "abc")).toMatchObject({
      message: expect.stringContaining("server_error"),
    });
  });

  it("errors when the code is missing and ignores other paths", () => {
    expect(parseCallback(`${CALLBACK_PATH}?state=abc`, "abc")).toMatchObject({ kind: "error" });
    expect(parseCallback("/favicon.ico", "abc")).toEqual({ kind: "ignore" });
    expect(parseCallback("/", "abc")).toEqual({ kind: "ignore" });
  });
});

describe("scopes and identity", () => {
  it("lists data scopes the user didn't grant", () => {
    expect(missingDataScopes("openid https://www.googleapis.com/auth/webmasters.readonly email")).toEqual([
      "https://www.googleapis.com/auth/analytics.readonly",
    ]);
    expect(missingDataScopes(undefined)).toHaveLength(2);
    // Tag Manager is requested but never required by the data-scope check.
    expect(missingDataScopes(DATA_SCOPES)).toEqual([]);
  });

  it("flags a missing Tag Manager scope only when the granted list is known", () => {
    expect(missingGtmScope(undefined)).toBe(false);
    expect(missingGtmScope("openid https://www.googleapis.com/auth/webmasters.readonly")).toBe(true);
    expect(missingGtmScope([GTM_SCOPE])).toBe(false);
  });

  it("reads the email claim from an ID token and tolerates junk", () => {
    expect(emailFromIdToken(idToken({ email: "a@example.com", sub: "1" }))).toBe("a@example.com");
    expect(emailFromIdToken(idToken({ sub: "1" }))).toBeUndefined();
    expect(emailFromIdToken("not-a-jwt")).toBeUndefined();
    expect(emailFromIdToken("a.!!!.c")).toBeUndefined();
    expect(emailFromIdToken(undefined)).toBeUndefined();
  });
});

describe("token file", () => {
  const stored = { refresh_token: "r1", access_token: "a1", expiry_date: 1, scope: "s", email: "a@example.com" };

  it("keeps the stored refresh token and email when a refresh omits them", () => {
    const merged = mergeTokens(stored, { access_token: "a2", expiry_date: 2, refresh_token: null, id_token: null });
    expect(merged).toEqual({ ...stored, access_token: "a2", expiry_date: 2 });
  });

  it("takes a new refresh token and email when they are returned", () => {
    const merged = mergeTokens(stored, { refresh_token: "r2", id_token: idToken({ email: "b@example.com" }) });
    expect(merged.refresh_token).toBe("r2");
    expect(merged.email).toBe("b@example.com");
  });

  it("refuses to build a token with no refresh token", () => {
    expect(() => mergeTokens(undefined, { access_token: "a" })).toThrow();
  });

  it("parses a valid file and gives readable errors for corrupt ones", () => {
    expect(parseTokenFile(JSON.stringify(stored), "/t.json")).toEqual(stored);
    expect(() => parseTokenFile("{nope", "/t.json")).toThrow(/not valid JSON.*auth login/);
    expect(() => parseTokenFile('{"access_token":"a"}', "/t.json")).toThrow(/no refresh token/);
  });

  describe("on disk", () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("writes atomically with mode 0600, overwrites, reads back and deletes", () => {
      dir = mkdtempSync(join(tmpdir(), "crawlmark-token-"));
      const path = join(dir, "nested", "google-token.json");
      expect(readTokenFile(path)).toBeUndefined();

      writeTokenFile(path, stored);
      if (POSIX_MODES) expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readTokenFile(path)).toEqual(stored);

      writeTokenFile(path, { ...stored, access_token: "a2" });
      expect(readTokenFile(path)?.access_token).toBe("a2");
      if (POSIX_MODES) expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(dir, "nested"))).toEqual(["google-token.json"]); // no temp files left

      expect(deleteTokenFile(path)).toBe(true);
      expect(deleteTokenFile(path)).toBe(false);
    });

    it("tightens permissions when overwriting a world-readable file", () => {
      dir = mkdtempSync(join(tmpdir(), "crawlmark-token-"));
      const path = join(dir, "google-token.json");
      writeFileSync(path, "{}", { mode: 0o644 });
      writeTokenFile(path, stored);
      if (POSIX_MODES) expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8")).refresh_token).toBe("r1");
    });
  });
});

describe("token errors", () => {
  const gaxiosLike = (error: string) =>
    Object.assign(new Error(error), { response: { status: 400, data: { error, error_description: "Bad Request" } } });

  it("maps invalid_grant to a re-login message that mentions the Testing-mode 7-day expiry", () => {
    expect(isInvalidGrant(gaxiosLike("invalid_grant"))).toBe(true);
    expect(isInvalidGrant(new Error('{"error":"invalid_grant","error_description":"ReAuth required"}'))).toBe(true);
    const mapped = mapTokenError(gaxiosLike("invalid_grant")) as Error;
    expect(mapped.message).toBe(invalidGrantMessage());
    expect(mapped.message).toMatch(/expired or was revoked/);
    expect(mapped.message).toMatch(cliRe("auth login"));
    expect(mapped.message).toMatch(/Testing.*7 days/);
  });

  it("doesn't double-wrap an already mapped error", () => {
    const mapped = mapTokenError(gaxiosLike("invalid_grant"));
    expect(mapTokenError(mapped)).toBe(mapped);
  });

  it("gives login code-exchange failures their own message, without the 7-day hint", () => {
    const msg = loginExchangeErrorMessage(gaxiosLike("invalid_grant"));
    expect(msg).toMatch(/^Sign-in failed: Google rejected the authorization code \(invalid_grant\)/);
    expect(msg).toMatch(cliRe("auth login"));
    expect(msg).not.toMatch(/7 days|expired or was revoked/);
    expect(loginExchangeErrorMessage(gaxiosLike("invalid_client"))).toMatch(/GOOGLE_OAUTH_CLIENT_ID/);
    expect(loginExchangeErrorMessage(new Error("socket hang up"))).toMatch(/\(socket hang up\)/);
  });

  it("passes other errors through unchanged", () => {
    const other = gaxiosLike("invalid_client");
    expect(mapTokenError(other)).toBe(other);
    expect(mapTokenError("x")).toBe("x");
  });
});

describe("CrawlmarkOAuth2Client", () => {
  // Local stand-in for Google's token endpoint (loopback only; no real network).
  let server: Server;
  let tokenUrl: string;
  let reply: { status: number; body: object } = { status: 400, body: {} };
  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(reply.status, { "Content-Type": "application/json" }).end(JSON.stringify(reply.body)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const client = () => {
    const c = new CrawlmarkOAuth2Client({ clientId: "id", clientSecret: "s", endpoints: { oauth2TokenUrl: tokenUrl } });
    c.setCredentials({ refresh_token: "r1", access_token: "old", expiry_date: Date.now() - 1000 });
    return c;
  };

  it("turns invalid_grant on refresh into the re-login message", async () => {
    reply = { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    await expect(client().getAccessToken()).rejects.toThrow(/sign-in expired or was revoked/);
  });

  it("emits refreshed tokens without a refresh_token, which mergeTokens keeps", async () => {
    reply = { status: 200, body: { access_token: "new", expires_in: 3600, token_type: "Bearer", scope: "s" } };
    const c = client();
    const emitted: Auth.Credentials[] = [];
    c.on("tokens", (t) => emitted.push({ ...t })); // snapshot: the library mutates it after emitting
    const { token } = await c.getAccessToken();
    expect(token).toBe("new");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.refresh_token).toBeUndefined();
    expect(mergeTokens({ refresh_token: "r1" }, emitted[0]!)).toMatchObject({ refresh_token: "r1", access_token: "new" });
  });

  describe("createOAuthClientLoader", () => {
    let dir: string;
    let tokenFile: string;
    const saveErrors: Error[] = [];
    const expired = { refresh_token: "r1", access_token: "old", expiry_date: 1, email: "a@example.com", scope: "s" };
    const loader = () =>
      createOAuthClientLoader({
        tokenFile,
        newClient: () =>
          new CrawlmarkOAuth2Client({ clientId: "id", clientSecret: "s", endpoints: { oauth2TokenUrl: tokenUrl } }),
        onSaveError: (e) => saveErrors.push(e),
      });
    /** Simulate `auth login` from another process: new content and a distinct mtime. */
    const reissue = (token: object) => {
      writeTokenFile(tokenFile, token as Parameters<typeof writeTokenFile>[1]);
      const t = new Date(Date.now() + 60_000);
      utimesSync(tokenFile, t, t);
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "crawlmark-loader-"));
      tokenFile = join(dir, "google-token.json");
      saveErrors.length = 0;
      reply = { status: 200, body: { access_token: "new", expires_in: 3600, token_type: "Bearer", scope: "s" } };
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("tells the user to log in when there is no token file", () => {
      expect(() => loader()()).toThrow(new RegExp("Run `" + cliRe("auth login").source + "`"));
    });

    it("persists a refresh: new access_token, refresh_token and email kept, same client reused", async () => {
      writeTokenFile(tokenFile, expired);
      const get = loader();
      const c = get();
      expect((await c.getAccessToken()).token).toBe("new");
      const saved = readTokenFile(tokenFile)!;
      expect(saved).toMatchObject({ refresh_token: "r1", access_token: "new", email: "a@example.com" });
      expect(saved.expiry_date).toBeGreaterThan(Date.now());
      if (POSIX_MODES) expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect(get()).toBe(c); // its own write doesn't force a rebuild
      expect(saveErrors).toEqual([]);
    });

    it("doesn't recreate the file after logout, and then asks for login", async () => {
      writeTokenFile(tokenFile, expired);
      const get = loader();
      const c = get();
      rmSync(tokenFile);
      await c.getAccessToken();
      expect(existsSync(tokenFile)).toBe(false);
      expect(() => get()).toThrow(/auth login/);
    });

    it("rebuilds the client when the file's mtime changes", () => {
      writeTokenFile(tokenFile, expired);
      const get = loader();
      const c1 = get();
      reissue({ ...expired, access_token: "fresh", expiry_date: Date.now() + 3_600_000 });
      const c2 = get();
      expect(c2).not.toBe(c1);
      expect(c2.credentials.access_token).toBe("fresh");
    });

    it("doesn't merge a stale client's refresh into a re-issued token for another account", async () => {
      writeTokenFile(tokenFile, expired);
      const get = loader();
      const stale = get();
      const accountB = { refresh_token: "r2", access_token: "b", expiry_date: Date.now() + 3_600_000, email: "b@example.com", scope: "s" };
      reissue(accountB);
      const before = readFileSync(tokenFile, "utf8");
      const mtime = statSync(tokenFile).mtimeMs;

      await stale.getAccessToken(); // refreshes with r1 and emits `tokens`

      expect(readFileSync(tokenFile, "utf8")).toBe(before);
      expect(statSync(tokenFile).mtimeMs).toBe(mtime);
      const fresh = get();
      expect(fresh).not.toBe(stale);
      expect(fresh.credentials.refresh_token).toBe("r2");
    });
  });
});

describe("describeAuthStatus", () => {
  it("summarises the active identity or the problem", () => {
    expect(
      describeAuthStatus({ mode: "oauth", auto: false, configured: true, signedIn: true, email: "a@example.com", tokenFile: "/t" }),
    ).toBe("Google auth: OAuth, signed in as a@example.com");
    expect(describeAuthStatus({ mode: "service_account", auto: false, configured: true, email: "sa@p.iam.gserviceaccount.com" })).toBe(
      "Google auth: service account sa@p.iam.gserviceaccount.com",
    );
    expect(describeAuthStatus({ mode: "oauth", auto: false, configured: false, signedIn: false, tokenFile: "/t", problem: "nope" })).toBe(
      "Google auth (oauth): nope",
    );
  });
});

describe("authIdentityKey", () => {
  it("keys by mode and account, never by an empty string", () => {
    expect(authIdentityKey({ mode: "service_account", auto: false, configured: true, email: "sa@proj.iam.gserviceaccount.com" })).toBe(
      "service_account:sa@proj.iam.gserviceaccount.com",
    );
    expect(authIdentityKey({ mode: "oauth", auto: false, configured: true, signedIn: true, email: "a@example.com", tokenFile: "/t" })).toBe(
      "oauth:a@example.com",
    );
    const noEmail = { mode: "oauth" as const, auto: false, configured: true, signedIn: true, tokenFile: "/t" };
    expect(authIdentityKey(noEmail, "abc123")).toBe("oauth:token:abc123");
    expect(authIdentityKey(noEmail, "def456")).not.toBe(authIdentityKey(noEmail, "abc123"));
    expect(authIdentityKey(noEmail)).toBe("oauth:token:none");
  });
});

describe("resolveAuthMode (auto-detect)", () => {
  const sa = { GOOGLE_APPLICATION_CREDENTIALS: "/k.json" };
  const oauth = { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s" };

  it("uses an explicit GOOGLE_AUTH_MODE whatever else is set", () => {
    expect(resolveAuthMode({ GOOGLE_AUTH_MODE: "oauth", ...sa })).toEqual({ mode: "oauth", auto: false });
    expect(resolveAuthMode({ GOOGLE_AUTH_MODE: "service_account", ...oauth })).toEqual({ mode: "service_account", auto: false });
    expect(resolveAuthMode({ GOOGLE_AUTH_MODE: "service_account" })).toEqual({ mode: "service_account", auto: false });
  });

  it("prefers a service-account key, then a complete OAuth client, then none", () => {
    expect(resolveAuthMode({ ...sa, ...oauth })).toEqual({ mode: "service_account", auto: true });
    expect(resolveAuthMode(oauth)).toEqual({ mode: "oauth", auto: true });
    expect(resolveAuthMode({ GOOGLE_OAUTH_CLIENT_ID: "id" })).toEqual({ mode: "none", auto: true });
    expect(resolveAuthMode({})).toEqual({ mode: "none", auto: true });
  });

  it("selectGoogleAuthConfig follows auto-detection and reports 'not set up' for none", () => {
    expect(selectGoogleAuthConfig(sa)).toEqual({ mode: "service_account", keyFile: "/k.json" });
    expect(selectGoogleAuthConfig(oauth)).toEqual({ mode: "oauth", clientId: "id", clientSecret: "s" });
    expect(() => selectGoogleAuthConfig({})).toThrow(GoogleNotConfiguredError);
    expect(() => selectGoogleAuthConfig({})).toThrow(/Google isn't set up.*README > Google/);
    // Explicit oauth with nothing configured keeps the specific setup message.
    expect(() => selectGoogleAuthConfig({ GOOGLE_AUTH_MODE: "oauth" })).toThrow(/GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET/);
  });

  it("describes the mode for auth status", () => {
    expect(describeAuthMode({ mode: "service_account", auto: true })).toBe("auto → service_account");
    expect(describeAuthMode({ mode: "oauth", auto: true })).toBe("auto → oauth");
    expect(describeAuthMode({ mode: "none", auto: true })).toBe("auto → not configured");
    expect(describeAuthMode({ mode: "oauth", auto: false })).toBe("oauth");
  });

  it("handles the not-configured status", () => {
    const none = { mode: "none" as const, auto: true as const, configured: false as const, problem: GOOGLE_NOT_CONFIGURED_MESSAGE };
    expect(describeAuthStatus(none)).toBe(GOOGLE_NOT_CONFIGURED_MESSAGE);
    expect(authIdentityKey(none)).toBe("none");
  });
});

describe("authModeNote", () => {
  const both = { GOOGLE_APPLICATION_CREDENTIALS: "/k.json", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s" };
  it("warns when auto-detection ignores a full OAuth client in favour of the service account", () => {
    expect(resolveAuthMode(both)).toEqual({ mode: "service_account", auto: true });
    expect(authModeNote(both)).toMatch(/OAUTH_CLIENT_SECRET are set but ignored.*possibly from your shell.*Set GOOGLE_AUTH_MODE/);
  });
  it("is silent when the mode is explicit or nothing is shadowed", () => {
    expect(authModeNote({ ...both, GOOGLE_AUTH_MODE: "service_account" })).toBeUndefined();
    expect(authModeNote({ GOOGLE_APPLICATION_CREDENTIALS: "/k.json", GOOGLE_OAUTH_CLIENT_ID: "id" })).toBeUndefined();
    expect(authModeNote({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s" })).toBeUndefined();
  });
});
