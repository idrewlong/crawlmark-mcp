import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Google on 127.0.0.1: an authorization endpoint (answers with a redirect back to the loopback
 * redirect_uri, like a user clicking Allow), a token endpoint (code and refresh_token grants) and a
 * tokeninfo endpoint. Nothing here leaves the machine. Behaviour is switched per test through `plan`.
 */
export interface TokenRequest {
  grant: string | null;
  params: URLSearchParams;
}

export interface FakeGoogle {
  origin: string;
  endpoints: { oauth2AuthBaseUrl: string; oauth2TokenUrl: string; oauth2RevokeUrl: string; tokenInfoUrl: string };
  /** Every request to the token endpoint, in order. */
  tokenRequests: TokenRequest[];
  /** Every request to the authorization endpoint. */
  authRequests: URL[];
  plan: {
    /** Status and JSON body for the token endpoint. Default: 200 with a refresh token. */
    token?: (req: TokenRequest) => { status: number; body: unknown };
    /** Scopes reported by tokeninfo. */
    tokenInfoScopes?: string[];
  };
  close(): Promise<void>;
}

export const DATA_SCOPES_GRANTED = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

export function idTokenFor(email: string): string {
  return ["e30", Buffer.from(JSON.stringify({ email })).toString("base64url"), "sig"].join(".");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString("utf8")));
    req.on("end", () => resolve(b));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" }).end(JSON.stringify(body));
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const fake: FakeGoogle = {
    origin: "",
    endpoints: { oauth2AuthBaseUrl: "", oauth2TokenUrl: "", oauth2RevokeUrl: "", tokenInfoUrl: "" },
    tokenRequests: [],
    authRequests: [],
    plan: {},
    close: async () => {},
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/auth") {
      fake.authRequests.push(url);
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "fake-auth-code");
      const state = url.searchParams.get("state");
      if (state !== null) redirect.searchParams.set("state", state);
      res.writeHead(302, { Location: redirect.toString(), Connection: "close" }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      const tr: TokenRequest = { grant: params.get("grant_type"), params };
      fake.tokenRequests.push(tr);
      if (fake.plan.token) {
        const r = fake.plan.token(tr);
        json(res, r.status, r.body);
        return;
      }
      const login = tr.grant === "authorization_code";
      json(res, 200, {
        access_token: login ? "fake-access-token" : "refreshed-access-token",
        ...(login ? { refresh_token: "fake-refresh-token", id_token: idTokenFor("signed-in@example.com") } : {}),
        scope: [...DATA_SCOPES_GRANTED, "https://www.googleapis.com/auth/tagmanager.readonly", "openid", "email"].join(" "),
        token_type: "Bearer",
        expires_in: 3599,
      });
      return;
    }
    if (url.pathname === "/tokeninfo") {
      json(res, 200, { aud: "test-client", scope: (fake.plan.tokenInfoScopes ?? DATA_SCOPES_GRANTED).join(" "), expires_in: 3000 });
      return;
    }
    res.writeHead(404, { Connection: "close" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.origin = origin;
  fake.endpoints = { oauth2AuthBaseUrl: `${origin}/auth`, oauth2TokenUrl: `${origin}/token`, oauth2RevokeUrl: `${origin}/revoke`, tokenInfoUrl: `${origin}/tokeninfo` };
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
