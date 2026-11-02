/**
 * 0.5.0 (Y4): the Google Docs handoff goes through the user's own Drive connector, so crawlmark's Google scopes stay
 * read-only and exactly the 0.4.0 lists. A Drive, Docs, Slides or write scope creeping in fails here.
 */
import { describe, expect, it } from "vitest";
import { DATA_SCOPES, GTM_SCOPE, OAUTH_SCOPES, SERVICE_ACCOUNT_SCOPES } from "../src/lib/google-auth.js";

const WEBMASTERS = "https://www.googleapis.com/auth/webmasters.readonly";
const ANALYTICS = "https://www.googleapis.com/auth/analytics.readonly";
const TAGMANAGER = "https://www.googleapis.com/auth/tagmanager.readonly";

describe("Google scopes stay read-only", () => {
  it("DATA_SCOPES, GTM_SCOPE, SERVICE_ACCOUNT_SCOPES and OAUTH_SCOPES equal the 0.4.0 lists", () => {
    expect([...DATA_SCOPES]).toEqual([WEBMASTERS, ANALYTICS]);
    expect(GTM_SCOPE).toBe(TAGMANAGER);
    expect([...SERVICE_ACCOUNT_SCOPES]).toEqual([WEBMASTERS, ANALYTICS, TAGMANAGER]);
    expect([...OAUTH_SCOPES]).toEqual([WEBMASTERS, ANALYTICS, TAGMANAGER, "openid", "email"]);
  });

  it("no scope names Drive, Docs or Slides, and every Google API scope is read-only", () => {
    for (const s of [...DATA_SCOPES, GTM_SCOPE, ...SERVICE_ACCOUNT_SCOPES, ...OAUTH_SCOPES]) {
      expect(s).not.toMatch(/drive|documents|presentations|spreadsheets/i);
      if (s.startsWith("https://")) expect(s.endsWith(".readonly"), s).toBe(true);
    }
  });
});
