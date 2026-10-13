import { existsSync } from "node:fs";
import { Auth } from "googleapis";
import { mapTokenError, mergeTokens, noTokenMessage, type StoredToken } from "../lib/google-auth.js";
import { readTokenFile, tokenFileMtime, writeTokenFile } from "../lib/token-store.js";

/**
 * OAuth2Client that turns `invalid_grant` on refresh into an actionable error.
 * Every refresh (proactive, or the retry after a 401) goes through refreshTokenNoCache.
 */
export class CrawlmarkOAuth2Client extends Auth.OAuth2Client {
  protected override async refreshTokenNoCache(refreshToken?: string | null) {
    try {
      return await super.refreshTokenNoCache(refreshToken);
    } catch (err) {
      throw mapTokenError(err);
    }
  }
}

export interface OAuthClientLoaderOptions {
  tokenFile: string;
  /** A client with the app's client ID/secret and no credentials. */
  newClient: () => Auth.OAuth2Client;
  onSaveError?: (err: Error) => void;
}

/**
 * Returns a getter for an OAuth client loaded from the token file. The client is
 * cached until the file's mtime changes (a login/logout from the CLI while the
 * server runs). Refreshed tokens are merged back into the file, but only while
 * the file still holds the refresh token this client was loaded with.
 */
export function createOAuthClientLoader(opts: OAuthClientLoaderOptions): () => Auth.OAuth2Client {
  const path = opts.tokenFile;
  let cached: { client: Auth.OAuth2Client; mtime: number | undefined } | undefined;

  return () => {
    const mtime = tokenFileMtime(path);
    if (cached && cached.mtime === mtime) return cached.client;
    cached = undefined;

    const stored = readTokenFile(path);
    if (!stored) throw new Error(noTokenMessage(path));

    const client = opts.newClient();
    client.setCredentials(stored);
    const entry = { client, mtime };
    let ownRefreshToken = stored.refresh_token;

    client.on("tokens", (tokens) => {
      try {
        // Signed out meanwhile (`auth logout`): don't resurrect the token file.
        if (!existsSync(path)) return;
        let current: StoredToken | undefined;
        try {
          current = readTokenFile(path);
        } catch {
          current = undefined; // corrupt: rewrite from what this client was loaded with
        }
        // Re-login (possibly as another account) since this client was built:
        // leave that file alone, and leave entry.mtime stale so the next call rebuilds.
        if (current && current.refresh_token !== ownRefreshToken) return;
        const merged = mergeTokens(current ?? stored, tokens);
        writeTokenFile(path, merged);
        ownRefreshToken = merged.refresh_token;
        entry.mtime = tokenFileMtime(path);
      } catch (err) {
        // Not fatal: the in-memory client still has the new access token.
        opts.onSaveError?.(err as Error);
      }
    });
    cached = entry;
    return client;
  };
}
