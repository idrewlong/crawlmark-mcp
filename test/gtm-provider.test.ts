import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** runGtmAudit and the container lookup against a mocked googleapis (no network) and the real SQLite cache in a temp DATA_DIR. */

const here = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(here, "fixtures/gtm/container-version.json"), "utf8"));

const state = vi.hoisted(() => ({
  identity: "",
  scopes: undefined as string[] | undefined,
  liveError: undefined as unknown,
  accountsError: undefined as unknown,
  containerGetError: undefined as unknown,
  live: undefined as unknown,
  calls: { live: 0 },
}));

const denied = { code: 403, message: "The caller does not have permission", response: { status: 403, data: { error: { message: "The caller does not have permission", errors: [] } } } };
const notFound = { code: 404, message: "Not found", response: { status: 404, data: { error: { message: "Not found", errors: [] } } } };

vi.mock("googleapis", () => ({
  google: {
    tagmanager: () => ({
      accounts: {
        list: async () => {
          if (state.accountsError) throw state.accountsError;
          return { data: { account: [{ accountId: "6000000001" }] } };
        },
        containers: {
          list: async () => ({
            data: { container: [{ accountId: "6000000001", containerId: "7000000001", publicId: "GTM-EXAMPL1", name: "Example", usageContext: ["web"], domainName: ["example.com"] }] },
          }),
          get: async () => {
            if (state.containerGetError) throw state.containerGetError;
            return { data: { publicId: "GTM-EXAMPL1", name: "Example", domainName: ["example.com"] } };
          },
          versions: {
            live: async () => {
              state.calls.live++;
              if (state.liveError) throw state.liveError;
              return { data: { ...version, container: { publicId: "GTM-EXAMPL1", name: "Example", domainName: ["example.com"] } } };
            },
          },
          workspaces: {
            list: async () => ({ data: { workspace: [{ workspaceId: "1", name: "Default Workspace", path: "accounts/6000000001/containers/7000000001/workspaces/1" }] } }),
            getStatus: async () => ({ data: { workspaceChange: [{ changeStatus: "updated", tag: { name: "GA4 Config" } }] } }),
          },
        },
      },
    }),
  },
}));

vi.mock("../src/providers/google.js", () => ({
  googleAuth: () => ({}),
  googleAuthIdentity: () => state.identity,
  assertGoogleConfigured: () => {},
  googleAuthStatus: () =>
    state.scopes
      ? { mode: "oauth", auto: false, configured: true, signedIn: true, email: "me@example.com", scopes: state.scopes }
      : { mode: "service_account", auto: false, configured: true, email: "crawlmark@example-project.iam.gserviceaccount.com" },
}));

const { runGtmAudit } = await import("../src/reports/gtm.js");

beforeEach(() => {
  state.scopes = undefined;
  state.liveError = undefined;
  state.containerGetError = undefined;
  state.calls = { live: 0 };
});

const client = { domain: "example.com", gtmAccountId: "6000000001", gtmContainerId: "7000000001" };

describe("runGtmAudit", () => {
  it("audits the live version and reports unpublished workspace changes, cached for repeat calls", async () => {
    state.identity = "test:gtm-audit";
    const r = await runGtmAudit(client);
    expect(r.container).toMatchObject({ publicId: "GTM-EXAMPL1", accountId: "6000000001", containerId: "7000000001" });
    expect(r.liveVersion).toEqual({ versionId: "42", name: "Example release" });
    expect(r.summary).toMatchObject({ tags: 11, findings: 12, bySeverity: { medium: 6, low: 6 }, consentModeDetected: true });
    expect(r.unpublishedChanges.totalChanges).toBe(1);
    expect(r.fromCache).toBe(false);
    expect((await runGtmAudit(client)).fromCache).toBe(true);
    expect(state.calls.live).toBe(1);
    await runGtmAudit(client, { refresh: true });
    expect(state.calls.live).toBe(2);
  });

  it("errors clearly when the client has no container", async () => {
    state.identity = "test:gtm-none";
    await expect(runGtmAudit({ domain: "example.com" })).rejects.toThrow(/No Tag Manager container found for example\.com.*clients\.yaml/s);
  });

  it("reports why discovery found nothing when the Tag Manager API is disabled", async () => {
    state.identity = "test:gtm-disabled";
    state.accountsError = { code: 403, message: "Tag Manager API has not been used in project 1 before or it is disabled.", response: { status: 403, data: { error: { message: "Tag Manager API has not been used in project 1 before or it is disabled.", errors: [] } } } };
    await expect(runGtmAudit({ domain: "example.com" })).rejects.toThrow(/Tag Manager API is disabled/);
    // Once the API is enabled, an explicit gtm_audit retry doesn't wait out the failure memory.
    state.accountsError = undefined;
    await expect(runGtmAudit({ domain: "example.com" })).rejects.toThrow(/No Tag Manager container found/);
  });

  it("resolves a pinned container id without an account, or a GTM- public id, through discovery", async () => {
    state.identity = "test:gtm-resolve";
    expect((await runGtmAudit({ domain: "example.com", gtmContainerId: "7000000001" })).container.accountId).toBe("6000000001");
    expect((await runGtmAudit({ domain: "example.com", gtmContainerId: "gtm-exampl1" })).container.containerId).toBe("7000000001");
    await expect(runGtmAudit({ domain: "example.com", gtmContainerId: "GTM-NOPE" })).rejects.toThrow(/isn't visible/);
  });

  it("explains how to grant access when Tag Manager denies it", async () => {
    state.identity = "test:gtm-denied";
    state.liveError = denied;
    await expect(runGtmAudit(client)).rejects.toThrow(/User Management.*crawlmark@example-project\.iam\.gserviceaccount\.com.*Read access/s);
  });

  it("reports a never-published container instead of failing", async () => {
    state.identity = "test:gtm-unpublished";
    state.liveError = notFound;
    const r = await runGtmAudit(client);
    expect(r.liveVersion).toBeNull();
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toMatch(/never been published/);
  });

  it("says the container is missing when both live and get 404", async () => {
    state.identity = "test:gtm-missing";
    state.liveError = notFound;
    state.containerGetError = notFound;
    await expect(runGtmAudit(client)).rejects.toThrow(/was not found/);
  });

  it("tells OAuth users to log in again when their token lacks the Tag Manager scope", async () => {
    state.identity = "test:gtm-scope";
    state.scopes = ["https://www.googleapis.com/auth/webmasters.readonly"];
    await expect(runGtmAudit(client)).rejects.toThrow(/crawlmark-cli auth login/);
    expect(state.calls.live).toBe(0);
  });
});
