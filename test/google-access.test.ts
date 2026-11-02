import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsRejectedMessage, ga4AccessDeniedMessage, ga4Error, gscAccessDeniedMessage, gscError } from "../src/lib/google-access.js";
import { cliHint, cliRe } from "./helpers/cli-hint.js";

const sa = { mode: "service_account" as const, email: "crawlmark@example-project.iam.gserviceaccount.com" };
const oauth = { mode: "oauth" as const, email: "you@example.com" };

describe("access-denied messages", () => {
  it("names the service account and the GA4 steps", () => {
    const m = ga4AccessDeniedMessage("123456789", sa);
    expect(m).toContain("GA4 property 123456789 isn't shared with crawlmark@example-project.iam.gserviceaccount.com (service account)");
    expect(m).toContain("Property access management > Add users");
    expect(m).toContain("Viewer");
    expect(m).toContain("HTTP 403");
  });
  it("names the OAuth account and the login command", () => {
    const m = ga4AccessDeniedMessage("properties/123456789", oauth);
    expect(m).toContain("GA4 property 123456789 isn't accessible to you@example.com (signed in with OAuth)");
    expect(m).toContain(`${cliHint()} auth login`);
  });
  it("is generic when the email is unknown", () => {
    expect(ga4AccessDeniedMessage("1", { mode: "oauth" })).toContain("could not read the account's email");
    expect(ga4AccessDeniedMessage("1", { mode: "service_account" })).toContain("the service account crawlmark uses");
    expect(ga4AccessDeniedMessage("1", { mode: "none" })).toContain("the Google account crawlmark uses");
  });
  it("covers Search Console", () => {
    expect(gscAccessDeniedMessage("sc-domain:example.com", sa)).toContain("Users and permissions");
    expect(gscAccessDeniedMessage("sc-domain:example.com", oauth)).toContain("isn't accessible to you@example.com");
  });
});

describe("classification", () => {
  const e403 = { response: { status: 403, data: { error: { message: "User does not have sufficient permissions for this property.", errors: [] } } } };
  it("rewrites a 403 only", () => {
    expect((ga4Error(e403, "properties/1", sa) as Error).message).toContain("isn't shared with");
    expect((gscError(e403, "sc-domain:example.com", oauth) as Error).message).toContain("isn't accessible to");
  });
  it("describes a 401 as rejected credentials, not a sharing problem", () => {
    const e401 = { response: { status: 401, data: { error: { message: "Request had invalid authentication credentials.", errors: [] } } } };
    const sa401 = (ga4Error(e401, "properties/1", sa) as Error).message;
    expect(sa401).toContain("rejected the credentials");
    expect(sa401).toContain("setup --step google");
    expect(sa401).not.toContain("isn't shared");
    const oa401 = (gscError(e401, "sc-domain:example.com", oauth) as Error).message;
    expect(oa401).toContain(`${cliHint()} auth login`);
    expect(oa401).toContain("you@example.com");
    expect(credentialsRejectedMessage("GA4", { mode: "none" })).toContain("the Google account crawlmark uses");
  });
  it("passes other errors through", () => {
    const e500 = { response: { status: 500, data: { error: { message: "boom" } } } };
    expect(ga4Error(e500, "properties/1", sa)).toBe(e500);
    const disabled = { response: { status: 403, data: { error: { message: "API has not been used in project 1 before", errors: [] } } } };
    expect(ga4Error(disabled, "properties/1", sa)).toBe(disabled);
  });
});

const state = vi.hoisted(() => ({ err: undefined as unknown }));
vi.mock("googleapis", () => ({
  google: {
    analyticsdata: () => ({ properties: { runReport: async () => { throw state.err; } } }),
    searchconsole: () => ({ searchanalytics: { query: async () => { throw state.err; } } }),
  },
}));
vi.mock("../src/providers/google.js", () => ({
  googleAuth: () => ({}),
  googleAuthIdentity: () => "test-identity",
  assertGoogleConfigured: () => {},
  googleAuthStatus: () => ({ mode: "service_account", auto: false, configured: true, email: "crawlmark@example-project.iam.gserviceaccount.com" }),
}));

describe("providers with a stubbed 403", () => {
  beforeEach(() => {
    state.err = { response: { status: 403, data: { error: { message: "User does not have sufficient permissions for this property.", errors: [] } } } };
  });
  const client = { domain: "example.com", ga4PropertyId: "123456789", gscProperty: "sc-domain:example.com" } as never;
  const range = { startDate: "2026-01-01", endDate: "2026-01-31" };

  it("ga4Report names the account to add", async () => {
    const { ga4Report } = await import("../src/providers/ga4.js");
    await expect(ga4Report(client, { ...range, metrics: ["sessions"] })).rejects.toThrow(/GA4 property 123456789 isn't shared with crawlmark@example-project\.iam\.gserviceaccount\.com/);
  });
  it("gscQuery names the account to add", async () => {
    const { gscQuery } = await import("../src/providers/gsc.js");
    await expect(gscQuery(client, range)).rejects.toThrow(/Search Console property sc-domain:example\.com isn't shared with crawlmark@/);
  });
});
