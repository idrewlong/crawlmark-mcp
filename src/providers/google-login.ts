import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Auth } from "googleapis";
import { newOAuthClient } from "./google.js";
import {
  authUrlOptions,
  CALLBACK_PATH,
  emailFromIdToken,
  loginExchangeErrorMessage,
  mergeTokens,
  missingDataScopes,
  parseCallback,
  type StoredToken,
} from "../lib/google-auth.js";
import { writeTokenFile } from "../lib/token-store.js";

export interface LoginOptions {
  tokenFile: string;
  /** How long to wait for the browser redirect. */
  timeoutMs?: number;
  openBrowser?: boolean;
  /** Progress output (the URL is always printed here as a fallback). */
  log: (line: string) => void;
}

export interface LoginResult {
  email?: string;
  scopes: string[];
  missingScopes: string[];
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Best-effort browser launch. Failure is fine: the URL has already been printed. */
function openInBrowser(url: string): void {
  const done = () => {};
  if (process.platform === "darwin") {
    execFile("open", [url], done);
  } else if (process.platform === "win32") {
    // `start` is a cmd builtin; quote the URL so cmd doesn't split on `&`.
    execFile("cmd", ["/c", "start", '""', `"${url}"`], { windowsVerbatimArguments: true }, done);
  } else {
    execFile("xdg-open", [url], done);
  }
}

function page(title: string, body: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${esc(title)}</h1><p>${esc(body)}</p></body>`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** Wait for the callback carrying our state (with a code or a Google error), or time out. */
function waitForCode(server: Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser sign-in.`));
    }, timeoutMs);

    server.on("request", (req, res) => {
      const result = parseCallback(req.url ?? "/", state);
      res.setHeader("Connection", "close");
      if (result.kind === "ignore") {
        res.writeHead(404).end();
        return;
      }
      if (result.kind === "reject") {
        // Wrong or missing state: never let it cancel the real sign-in.
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(page("Invalid or stale sign-in link", `This link doesn't match the sign-in in progress. Use the browser tab opened by the sign-in command, or run the login again.`));
        return;
      }
      if (settled) {
        res.writeHead(409, { "Content-Type": "text/html; charset=utf-8" })
          .end(page("Already handled", "This sign-in has already finished. Check your terminal."));
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (result.kind === "error") {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(page("Sign-in failed", result.message));
        reject(new Error(result.message));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(page("Signed in to crawlmark", "You can close this tab and return to the terminal."));
      resolve(result.code);
    });
  });
}

/**
 * OAuth loopback flow for an installed (Desktop) client: temporary server on
 * 127.0.0.1:<random>, PKCE (S256), state check, offline access. Stores the
 * token at `tokenFile` (0600) and returns who signed in.
 */
export async function loopbackLogin(opts: LoginOptions): Promise<LoginResult> {
  const server = createServer();
  let tokens: Auth.Credentials;
  try {
    const port = await listen(server);
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const client = newOAuthClient(redirectUri);
    const state = randomBytes(32).toString("base64url");
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    if (!codeChallenge) throw new Error("Could not generate a PKCE code challenge.");

    const url = client.generateAuthUrl({
      ...authUrlOptions({ redirectUri, state, codeChallenge }),
      code_challenge_method: Auth.CodeChallengeMethod.S256,
    });

    opts.log("Opening your browser to sign in to Google. If it doesn't open, visit this URL:");
    opts.log("");
    opts.log(url);
    opts.log("");
    if (opts.openBrowser !== false) openInBrowser(url);

    const code = await waitForCode(server, state, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      ({ tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri }));
    } catch (err) {
      throw new Error(loginExchangeErrorMessage(err), { cause: err });
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove crawlmark's access at https://myaccount.google.com/permissions and log in again.",
    );
  }
  const stored: StoredToken = mergeTokens(undefined, tokens);
  writeTokenFile(opts.tokenFile, stored);

  const scopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  const email = emailFromIdToken(tokens.id_token);
  return { ...(email ? { email } : {}), scopes, missingScopes: missingDataScopes(scopes) };
}
