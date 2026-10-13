import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeContainerVersion,
  consentFindings,
  countBySeverity,
  duplicateGa4Findings,
  summarizeWorkspaces,
  type GtmContainerVersion,
} from "../src/analysis/gtm.js";
import { normalizeHost, parseOverrides, planSync } from "../src/lib/clients.js";
import {
  accessDeniedMessage,
  apiErrorInfo,
  classifyGtmError,
  containersFromResponse,
  gtmApiError,
  joinGtmContainers,
  gtmNotes,
} from "../src/lib/gtm.js";

const here = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(here, "fixtures/gtm/container-version.json"), "utf8")) as GtmContainerVersion;
const containerFixtures = JSON.parse(readFileSync(join(here, "fixtures/google/gtm-containers.json"), "utf8")) as Record<string, object>;

const rulesOf = (rule: string) => analyzeContainerVersion(version).findings.filter((f) => f.rule === rule);
const namesOf = (rule: string) => rulesOf(rule).map((f) => f.entity.name).sort();

describe("analyzeContainerVersion (fixture container)", () => {
  const analysis = analyzeContainerVersion(version);

  it("counts entities and sorts findings medium before low", () => {
    expect(analysis.counts).toEqual({ tags: 11, triggers: 6, variables: 4 });
    expect(analysis.findings).toHaveLength(12);
    expect(countBySeverity(analysis.findings)).toEqual({ medium: 6, low: 6 });
    const severities = analysis.findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === "medium" ? -1 : 1)));
    expect(analysis.findings.every((f) => f.source === "gtm")).toBe(true);
  });

  it("flags legacy UA by tag type and by UA ID in a Custom HTML snippet", () => {
    expect(namesOf("legacy-ua")).toEqual(["Old snippet", "UA pageview"]);
    expect(rulesOf("legacy-ua").every((f) => f.severity === "medium")).toBe(true);
  });

  it("flags tags with no firing trigger, except paused tags and setup/teardown tags", () => {
    expect(namesOf("no-firing-trigger")).toEqual(["Orphan event"]);
    expect(rulesOf("no-firing-trigger")[0]!.severity).toBe("medium");
  });

  it("flags paused tags as low", () => {
    expect(namesOf("paused-tag")).toEqual(["Paused remarketing"]);
    expect(rulesOf("paused-tag")[0]!.severity).toBe("low");
  });

  it("finds duplicate Google tag / GA4 config tags for one measurement ID, resolving constant variables", () => {
    const dup = rulesOf("duplicate-ga4-config");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.title).toContain("G-EXAMPLE1");
    expect(dup[0]!.evidence).toContain("Google tag G-EXAMPLE1");
    expect(dup[0]!.evidence).toContain("GA4 Config (dup)");
    expect(dup[0]!.severity).toBe("medium");
  });

  it("ignores paused tags and distinct IDs when looking for duplicates", () => {
    const tags = [
      { tagId: "1", name: "A", type: "gaawc", parameter: [{ key: "measurementId", value: "G-EXAMPLE1" }] },
      { tagId: "2", name: "B", type: "gaawc", paused: true, parameter: [{ key: "measurementId", value: "G-EXAMPLE1" }] },
      { tagId: "3", name: "C", type: "googtag", parameter: [{ key: "tagId", value: "G-EXAMPLE2" }] },
    ];
    expect(duplicateGa4Findings(tags, [])).toEqual([]);
  });

  it("finds unused variables (escaped names included) and unused triggers (groups and blockers count as use)", () => {
    expect(namesOf("unused-variable")).toEqual(['Unused "quoted" var', "Old UA ID"].sort());
    expect(namesOf("unused-trigger")).toEqual(["Nobody uses me"]);
    expect(rulesOf("unused-variable").concat(rulesOf("unused-trigger")).every((f) => f.severity === "low")).toBe(true);
  });

  it("lists custom HTML tags for review", () => {
    expect(namesOf("custom-html")).toEqual(["Chat widget", "Old snippet"]);
    expect(rulesOf("custom-html")[0]!.severity).toBe("low");
  });

  it("flags tags without consent settings when Consent Mode is used elsewhere", () => {
    expect(analysis.consentModeDetected).toBe(true);
    // Google tags have consent checks built in; the Custom HTML tag with consent 'needed' is configured.
    expect(namesOf("missing-consent-settings")).toEqual(["Chat widget", "Tracked pixel"]);
  });

  it("doesn't flag a CMP tag that fires only on Consent Initialization triggers", () => {
    expect(namesOf("missing-consent-settings")).not.toContain("CMP banner");
    const tags = [{ tagId: "1", name: "CMP", type: "cvt_X", firingTriggerId: ["5"] }, { tagId: "2", name: "Mixed", type: "cvt_X", firingTriggerId: ["5", "6"] }];
    const triggers = [{ triggerId: "5", type: "consentInit" }, { triggerId: "6", type: "pageview" }];
    expect(consentFindings(tags, triggers).map((f) => f.entity.name)).toEqual(["Mixed"]);
  });

  it("raises no consent findings when Consent Mode is not in use", () => {
    expect(consentFindings([{ tagId: "1", name: "Pixel", type: "img" }], [{ triggerId: "1", type: "pageview" }])).toEqual([]);
  });

  it("gives stable IDs and handles an empty container", () => {
    const again = analyzeContainerVersion(JSON.parse(JSON.stringify(version)) as GtmContainerVersion);
    expect(again.findings.map((f) => f.id)).toEqual(analysis.findings.map((f) => f.id));
    expect(new Set(analysis.findings.map((f) => f.id)).size).toBe(analysis.findings.length);
    expect(analyzeContainerVersion({}).findings).toEqual([]);
  });
});

describe("summarizeWorkspaces", () => {
  it("counts changed entities per workspace and drops clean workspaces", () => {
    const out = summarizeWorkspaces([
      {
        workspaceId: "1",
        name: "Default Workspace",
        status: {
          workspaceChange: [
            { changeStatus: "updated", tag: { name: "GA4 Config" } },
            { changeStatus: "added", trigger: { name: "New click" } },
            { changeStatus: "deleted", variable: { name: "Old var" } },
          ],
          mergeConflict: [{}],
        },
      },
      { workspaceId: "2", name: "Clean", status: { workspaceChange: [] } },
      { workspaceId: "3", name: "Other", status: { workspaceChange: [{ changeStatus: "added", tag: { name: "T" } }] } },
    ]);
    expect(out.totalChanges).toBe(4);
    expect(out.workspaces.map((w) => w.name)).toEqual(["Default Workspace", "Other"]);
    expect(out.workspaces[0]).toMatchObject({ changes: 3, byType: { tag: 1, trigger: 1, variable: 1 }, mergeConflicts: 1 });
    expect(out.workspaces[0]!.sample[0]).toBe("tag: GA4 Config (updated)");
  });
});

describe("container join", () => {
  const all = Object.values(containerFixtures).flatMap((r) => containersFromResponse(r));

  it("keeps web containers only", () => {
    expect(all.map((c) => c.publicId)).toEqual(["GTM-EXAMPL1", "GTM-EXAMPL2", "GTM-EXAMPL4"]);
  });

  it("matches domains through the host normaliser; the lowest GTM ID wins and the rest are alternates", () => {
    const { matches, unmatched } = joinGtmContainers(all, normalizeHost);
    expect([...matches.keys()].sort()).toEqual(["example.com", "example.net"]);
    expect(matches.get("example.com")).toMatchObject({ gtmAccountId: "6000000001", gtmContainerId: "7000000001", publicId: "GTM-EXAMPL1" });
    expect(matches.get("example.net")!.publicId).toBe("GTM-EXAMPL1");
    expect(matches.get("example.net")!.alternates).toEqual([{ gtmAccountId: "6000000002", gtmContainerId: "7000000004", publicId: "GTM-EXAMPL4" }]);
    expect(unmatched.map((c) => c.publicId)).toEqual(["GTM-EXAMPL2"]);
  });

  it("drops the alternates note for hosts whose client already pins a container", () => {
    const { matches, unmatched } = joinGtmContainers(all, normalizeHost);
    const listing = { containers: all, errors: [] };
    expect(gtmNotes(listing, matches, unmatched, new Set(["example.net"])).some((n) => n.includes("listed by"))).toBe(false);
  });

  it("notes containers without a domain list and ambiguous hosts", () => {
    const { matches, unmatched } = joinGtmContainers(all, normalizeHost);
    const notes = gtmNotes({ containers: all, errors: ["Tag Manager account 1: could not list containers: boom"] }, matches, unmatched);
    expect(notes.some((n) => n.includes("GTM-EXAMPL2") && n.includes("no domain"))).toBe(true);
    expect(notes.some((n) => n.includes("example.net") && n.includes("GTM-EXAMPL4"))).toBe(true);
    expect(notes).toContain("Tag Manager account 1: could not list containers: boom");
  });
});

describe("planSync with Tag Manager containers", () => {
  const { matches } = joinGtmContainers(Object.values(containerFixtures).flatMap((r) => containersFromResponse(r)), normalizeHost);
  const overrides = (yaml: object) => parseOverrides(yaml, "test");

  it("adds the pair to a new entry and fills it on an existing entry", () => {
    const plan = planSync(
      overrides({ clients: { "example.net": { domain: "example.net" } } }),
      [{ domain: "example.com", gscAlternates: [], ga4Alternates: [] }],
      matches,
    );
    expect(plan.add[0]).toMatchObject({ domain: "example.com", gtmAccountId: "6000000001", gtmContainerId: "7000000001" });
    expect(plan.fill).toEqual([
      { key: "example.net", domain: "example.net", field: "gtmAccountId", value: "6000000001" },
      { key: "example.net", domain: "example.net", field: "gtmContainerId", value: "7000000001" },
    ]);
  });

  it("never overwrites a pinned container, even when only one id is set, and skips ignored entries", () => {
    const plan = planSync(
      overrides({
        clients: {
          "example.com": { domain: "example.com", gtmContainerId: 123 },
          "example.net": { domain: "example.net", gtmAccountId: "9", gtmContainerId: "8" },
        },
      }),
      [],
      matches,
    );
    expect(plan.fill).toEqual([]);
    expect(planSync(overrides({ clients: { "example.com": { domain: "example.com", ignore: true } } }), [], matches).fill).toEqual([]);
  });

  it("accepts unquoted numeric ids in clients.yaml", () => {
    const [o] = overrides({ clients: { "example.com": { domain: "example.com", gtmAccountId: 6000000001, gtmContainerId: 7000000001 } } });
    expect([o!.gtmAccountId, o!.gtmContainerId]).toEqual(["6000000001", "7000000001"]);
  });
});

describe("Tag Manager errors", () => {
  const sa = { mode: "service_account" as const, email: "crawlmark@example-project.iam.gserviceaccount.com" };
  const gaxios = (status: number, message: string, reason?: string) => ({
    code: status,
    message,
    response: { status, data: { error: { message, errors: reason ? [{ reason }] : [] } } },
  });

  it("explains how to add the service account when access is denied", () => {
    const err = gtmApiError(gaxios(403, "The caller does not have permission"), "accounts/1/containers/2", sa);
    expect(err.message).toContain("crawlmark@example-project.iam.gserviceaccount.com");
    expect(err.message).toContain("Admin > User Management");
    expect(err.message).toContain("Read access");
  });

  it("names the signed-in account for OAuth", () => {
    expect(accessDeniedMessage("accounts/1/containers/2", { mode: "oauth", email: "me@example.com" })).toContain("signed-in Google account me@example.com");
  });

  it("tells OAuth users to log in again when the scope is missing", () => {
    const err = gtmApiError(gaxios(403, "Request had insufficient authentication scopes.", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"), "p", { mode: "oauth" });
    expect(err.message).toContain("crawlmark-cli auth login");
  });

  it("treats quota and rate-limit 403s as rate limiting, not denied access", () => {
    const e = { code: 403, message: "Quota exceeded", response: { status: 403, data: { error: { message: "Quota exceeded for quota metric", errors: [{ reason: "rateLimitExceeded" }] } } } };
    expect(classifyGtmError(apiErrorInfo(e))).toBe("rate-limit");
    expect(gtmApiError(e, "p", sa).message).toMatch(/rate limiting/);
    expect(gtmApiError(e, "p", sa).message).not.toMatch(/User Management/);
  });

  it("recognises a disabled API, not-found and other failures", () => {
    expect(classifyGtmError(apiErrorInfo(gaxios(403, "Tag Manager API has not been used in project 1 before or it is disabled.")))).toBe("api-disabled");
    expect(classifyGtmError(apiErrorInfo(gaxios(404, "Not found")))).toBe("not-found");
    expect(classifyGtmError(apiErrorInfo(new Error("socket hang up")))).toBe("other");
    expect(gtmApiError(gaxios(404, "Not found"), "accounts/1/containers/2", sa).message).toContain("not the GTM-XXXX ID");
    expect(gtmApiError(new Error("socket hang up"), "accounts/1/containers/2", sa).message).toContain("socket hang up");
  });
});
