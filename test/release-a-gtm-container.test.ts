/**
 * D2: gtm_audit audits the container the live homepage loads, not the lowest ID. Tag Manager is a mocked googleapis
 * (no network); the homepage is injected through deps.fetchHomepage.
 */
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ liveCalls: [] as string[], rawCalls: [] as { url: string; refresh?: boolean }[] }));

vi.mock("../src/providers/render.js", async (orig) => ({
  ...(await orig<typeof import("../src/providers/render.js")>()),
  fetchRaw: async (url: string, o: { refresh?: boolean } = {}) => {
    state.rawCalls.push({ url, ...(o.refresh ? { refresh: true } : {}) });
    return { status: 200, html: "<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-BBBB222');</script>" };
  },
}));

const PUBLIC: Record<string, string> = { "7000000001": "GTM-AAAA111", "7000000002": "GTM-BBBB222", "7000000003": "GTM-CCCC333", "7000000004": "GTM-DDDD444" };

vi.mock("googleapis", () => ({
  google: {
    tagmanager: () => ({
      accounts: {
        list: async () => ({ data: { account: [{ accountId: "6000000001" }] } }),
        containers: {
          list: async () => ({
            data: {
              container: [
                { accountId: "6000000001", containerId: "7000000001", publicId: "GTM-AAAA111", name: "Old site", usageContext: ["web"], domainName: ["example.com"] },
                { accountId: "6000000001", containerId: "7000000002", publicId: "GTM-BBBB222", name: "Current site", usageContext: ["web"], domainName: ["example.com"] },
                { accountId: "6000000001", containerId: "7000000003", publicId: "GTM-CCCC333", name: "Other", usageContext: ["web"], domainName: ["other.example.net"] },
                { accountId: "6000000001", containerId: "7000000004", publicId: "GTM-DDDD444", name: "No domains listed", usageContext: ["web"], domainName: [] },
              ],
            },
          }),
          get: async () => ({ data: {} }),
          versions: {
            live: async ({ parent }: { parent: string }) => {
              const id = parent.split("/containers/")[1]!;
              state.liveCalls.push(id);
              return { data: { tag: [], trigger: [], variable: [], container: { publicId: PUBLIC[id], name: `container ${id}`, domainName: ["example.com"] }, containerVersionId: "3" } };
            },
          },
          workspaces: { list: async () => ({ data: { workspace: [] } }), getStatus: async () => ({ data: {} }) },
        },
      },
    }),
  },
}));

vi.mock("../src/providers/google.js", () => ({
  googleAuth: () => ({}),
  googleAuthIdentity: () => "test:gtm-container",
  assertGoogleConfigured: () => {},
  googleAuthStatus: () => ({ mode: "service_account", auto: false, configured: true, email: "crawlmark@example-project.iam.gserviceaccount.com" }),
}));

const { runGtmAudit } = await import("../src/reports/gtm.js");
const { extractGtmIds, gtmNotes, joinGtmContainers } = await import("../src/lib/gtm.js");
const { normalizeHost } = await import("../src/lib/clients.js");
const { cliPrefix } = await import("../src/setup/status-providers.js");

const A = { gtmAccountId: "6000000001", gtmContainerId: "7000000001", publicId: "GTM-AAAA111", matchedBy: "domain" as const };
const B = { gtmAccountId: "6000000001", gtmContainerId: "7000000002", publicId: "GTM-BBBB222", matchedBy: "domain" as const };
const page = (...ids: string[]) => async () => `<html><head><script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','${ids[0] ?? ""}');</script>${ids.map((i) => `<iframe src="https://www.googletagmanager.com/ns.html?id=${i}"></iframe>`).join("")}</head></html>`;
const unreadable = async () => {
  throw new Error("connect ECONNREFUSED");
};
const opts = { refresh: true };

describe("extractGtmIds", () => {
  const snippet = (id: string, layer = "dataLayer") =>
    `<script>(function(w,d,s,l,i){w[l]=w[l]||[];})(window,document,'script','${layer}','${id}');</script>`;

  it("finds loader IDs in page order, uppercased, de-duplicated, at most 10", () => {
    expect(extractGtmIds(`${snippet("GTM-BBBB222")}${snippet("GTM-AAAA111")}${snippet("GTM-BBBB222")}`)).toEqual(["GTM-BBBB222", "GTM-AAAA111"]);
    expect(extractGtmIds(snippet("gtm-bbbb222"))).toEqual(["GTM-BBBB222"]);
    const many = Array.from({ length: 14 }, (_, i) => snippet(`GTM-AAAA${String(i).padStart(3, "0")}`)).join("\n");
    expect(extractGtmIds(many)).toHaveLength(10);
  });

  it("detects the standard snippet forms", () => {
    expect(extractGtmIds(snippet("GTM-AAAA111"))).toEqual(["GTM-AAAA111"]);
    expect(extractGtmIds(snippet("GTM-AAAA111", "myLayer"))).toEqual(["GTM-AAAA111"]);
    expect(extractGtmIds('<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-AAAA111" height="0"></iframe>')).toEqual(["GTM-AAAA111"]);
    expect(extractGtmIds('<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-AAAA111&l=dataLayer"></script>')).toEqual(["GTM-AAAA111"]);
    expect(extractGtmIds('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-AAAA111&amp;gtm_auth=abc&amp;gtm_preview=env-2"></script>')).toEqual(["GTM-AAAA111"]);
    expect(extractGtmIds("<script src='https://www.googletagmanager.com/gtm.js?l=dataLayer&amp;id=GTM-AAAA111'></script>")).toEqual(["GTM-AAAA111"]);
    expect(extractGtmIds('<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-AAAA111&gtm_auth=x"></iframe>')).toEqual(["GTM-AAAA111"]);
  });

  it("ignores IDs in body text, comments and unrelated markup", () => {
    expect(extractGtmIds("<p>Our partner uses GTM-BBBB222 for tracking.</p><!-- GTM-CCCC333 -->")).toEqual([]);
    expect(extractGtmIds('<a href="https://example.com/?ref=GTM-BBBB222">x</a><div data-id="GTM-CCCC333"></div>')).toEqual([]);
    expect(extractGtmIds("no ids here, GTM-A and XGTM-AAAA111")).toEqual([]);
    expect(extractGtmIds(`<p>See GTM-BBBB222</p>${snippet("GTM-AAAA111")}`)).toEqual(["GTM-AAAA111"]);
  });
});

describe("gtm_audit homepage read honours refresh (R1)", () => {
  it("passes refresh to the homepage fetch so a stale cached page can't pick the container", async () => {
    state.rawCalls.length = 0;
    await runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A, B] }, { refresh: true });
    expect(state.rawCalls).toEqual([{ url: "https://example.com/", refresh: true }]);
    state.rawCalls.length = 0;
    await runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A, B] }, { refresh: false });
    expect(state.rawCalls).toEqual([{ url: "https://example.com/" }]);
  });
});

describe("gtm_audit container choice (C14)", () => {
  it("audits the container the live homepage loads when two candidates match", async () => {
    state.liveCalls = [];
    const r = await runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A, B] }, opts, { fetchHomepage: page("GTM-BBBB222") });
    expect(r.container.publicId).toBe("GTM-BBBB222");
    expect(state.liveCalls).toEqual(["7000000002"]);
    expect(r.containerCheck).toEqual({ pageUrl: "https://example.com/", pageIds: ["GTM-BBBB222"], chosenBy: "live-page", onPage: true });
    expect(r.notes).toContain("Chose GTM-BBBB222 because the live homepage loads it (other candidates: GTM-AAAA111).");
  });

  it("uses a pinned container and warns when the page loads a different one", async () => {
    const r = await runGtmAudit({ domain: "example.com", gtmPinned: true, gtmContainerId: "GTM-AAAA111" }, opts, { fetchHomepage: page("GTM-BBBB222") });
    expect(r.container.publicId).toBe("GTM-AAAA111");
    expect(r.containerCheck).toMatchObject({ chosenBy: "pinned", onPage: false, pageIds: ["GTM-BBBB222"] });
    expect(r.notes).toContain("The live homepage loads GTM-BBBB222, not the pinned GTM-AAAA111. Check gtmContainerId.");
  });

  it("a pinned container on the page gives no warning, and an unreadable page leaves onPage null", async () => {
    const ok = await runGtmAudit({ domain: "example.com", gtmPinned: true, gtmAccountId: "6000000001", gtmContainerId: "7000000001" }, opts, { fetchHomepage: page("GTM-AAAA111") });
    expect(ok.containerCheck).toMatchObject({ chosenBy: "pinned", onPage: true });
    expect(ok.notes.some((n) => n.includes("pinned"))).toBe(false);
    const none = await runGtmAudit({ domain: "example.com", gtmPinned: true, gtmContainerId: "7000000002", gtmAccountId: "6000000001" }, opts, { fetchHomepage: unreadable });
    expect(none.containerCheck).toMatchObject({ chosenBy: "pinned", pageIds: null, onPage: null });
  });

  it("takes a container the page loads that is visible, not a candidate and lists no domains, with a note", async () => {
    const r = await runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A, B] }, opts, { fetchHomepage: page("GTM-DDDD444") });
    expect(r.container.publicId).toBe("GTM-DDDD444");
    expect(r.containerCheck.chosenBy).toBe("live-page");
    expect(r.notes).toContain("GTM-DDDD444 is loaded by the live homepage but its Tag Manager settings don't list example.com.");
  });

  it("does not audit a visible container that lists other domains, even when the page names it", async () => {
    const cli = cliPrefix();
    state.liveCalls.length = 0;
    await expect(runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A, B] }, opts, { fetchHomepage: page("GTM-CCCC333") })).rejects.toThrow(
      `Pin one with set_client_profile gtmContainerId (or ${cli} clients set example.com --gtm-container GTM-XXXX).`,
    );
    expect(state.liveCalls).toEqual([]);
  });

  it("ignores another client's container ID that appears only in body text", async () => {
    const text = async () => `<html><body><p>Partner: GTM-CCCC333</p><!-- GTM-DDDD444 --></body></html>`;
    await expect(runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A, B] }, opts, { fetchHomepage: text })).rejects.toThrow(/matches 2 Tag Manager containers/);
    const r = await runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A], gtmAccountId: A.gtmAccountId, gtmContainerId: A.gtmContainerId }, opts, { fetchHomepage: text });
    expect(r.container.publicId).toBe("GTM-AAAA111");
    expect(r.containerCheck.pageIds).toEqual([]);
  });

  it("falls back to the only candidate when the page loads a container this account can't see", async () => {
    const r = await runGtmAudit(
      { domain: "example.com", gtmPinned: false, gtmCandidates: [A], gtmAccountId: A.gtmAccountId, gtmContainerId: A.gtmContainerId },
      opts,
      { fetchHomepage: page("GTM-ZZZZ999") },
    );
    expect(r.container.publicId).toBe("GTM-AAAA111");
    expect(r.containerCheck).toMatchObject({ chosenBy: "only-candidate", onPage: false });
    expect(r.notes).toContain("The live homepage loads GTM-ZZZZ999, which this Google account can't see; auditing GTM-AAAA111 instead.");
  });

  it("falls back to the only candidate with a note when the page can't be read", async () => {
    const r = await runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A], gtmAccountId: A.gtmAccountId, gtmContainerId: A.gtmContainerId }, opts, {
      fetchHomepage: unreadable,
    });
    expect(r.containerCheck).toEqual({ pageUrl: "https://example.com/", pageIds: null, chosenBy: "only-candidate", onPage: null });
    expect(r.notes).toContain("Couldn't read the live homepage to confirm the container.");
  });

  it("refuses with the candidate list and the pin command when 2+ candidates and none is on the page", async () => {
    const cli = cliPrefix();
    for (const fetchHomepage of [page(), page("GTM-ZZZZ999"), unreadable]) {
      await expect(runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A, B] }, opts, { fetchHomepage })).rejects.toThrow(
        `example.com matches 2 Tag Manager containers (GTM-AAAA111, GTM-BBBB222) and the live homepage doesn't show which one it loads. ` +
          `Pin one with set_client_profile gtmContainerId (or ${cli} clients set example.com --gtm-container GTM-XXXX).`,
      );
    }
  });

  it("throws the existing no-container error with zero candidates and nothing usable on the page", async () => {
    await expect(runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [] }, opts, { fetchHomepage: page("GTM-ZZZZ999") })).rejects.toThrow(
      /No Tag Manager container found for example\.com/,
    );
  });

  it("with zero candidates, still finds a visible container the page loads", async () => {
    const r = await runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [] }, opts, { fetchHomepage: page("GTM-DDDD444") });
    expect(r.container.publicId).toBe("GTM-DDDD444");
    expect(r.containerCheck.chosenBy).toBe("live-page");
  });

  it("a lone candidate that is on the page is simply live-page, with no 'chose' note", async () => {
    const r = await runGtmAudit({ domain: "example.com", gtmPinned: false, gtmCandidates: [A], gtmAccountId: A.gtmAccountId, gtmContainerId: A.gtmContainerId }, opts, {
      fetchHomepage: page("GTM-AAAA111"),
    });
    expect(r.containerCheck).toMatchObject({ chosenBy: "live-page", onPage: true });
    expect(r.notes.some((n) => n.startsWith("Chose"))).toBe(false);
  });
});

describe("gtmNotes for ambiguous hosts", () => {
  it("no longer says the lowest ID is used", () => {
    const containers = [
      { accountId: "1", containerId: "11", publicId: "GTM-AAAA111", name: "A", domainName: ["example.com"] },
      { accountId: "1", containerId: "12", publicId: "GTM-BBBB222", name: "B", domainName: ["example.com"] },
    ];
    const { matches, unmatched } = joinGtmContainers(containers, normalizeHost);
    const notes = gtmNotes({ containers, errors: [] }, matches, unmatched);
    expect(notes).toContain(
      "Tag Manager: example.com is listed by 2 containers (GTM-AAAA111, GTM-BBBB222); gtm_audit picks the one the live homepage loads. Pin one with set_client_profile gtmContainerId.",
    );
    expect(notes.join("\n")).not.toMatch(/using GTM/);
  });
});
