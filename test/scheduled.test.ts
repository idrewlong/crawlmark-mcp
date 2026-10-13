import { describe, expect, it, vi } from "vitest";
import type { StoredAudit } from "../src/analysis/diff.js";
import type { Finding } from "../src/analysis/findings.js";
import type { Client } from "../src/config.js";
import type { GscRow } from "../src/providers/gsc.js";
import { runAudits, runTrafficChecks, type AuditDeps } from "../src/scheduled.js";

const client = (domain: string, extra: Partial<Client> = {}): Client =>
  ({ slug: domain, domain, name: "Example Plumbing", keyPages: [`https://${domain}/`], brandTerms: [], ...extra }) as unknown as Client;

const f = (id: string, severity: Finding["severity"]): Finding => ({ id, source: "onpage", rule: id, url: "https://example.com/", severity, title: id });
const audit = (id: string, ranAt: number, findings: Finding[]): StoredAudit => ({
  id,
  client: "example.com",
  ranAt,
  settings: { formFactor: "mobile", wcagLevel: "AA", fresh: true },
  summary: {},
  findings,
  checked: [{ url: "https://example.com", source: "onpage" }],
  result: {},
});

function auditDeps(stored: StoredAudit[], fail: string[] = []): AuditDeps {
  return {
    runAudit: async (c) => {
      if (fail.includes(c.slug)) throw new Error("chrome exploded");
      return { auditId: "new" };
    },
    getAudit: (id) => stored.find((a) => a.id === id),
    latestAuditBefore: (_c, before) => stored.filter((a) => a.id !== "new" && a.ranAt < before).sort((a, b) => b.ranAt - a.ranAt)[0],
  };
}

describe("runAudits", () => {
  it("alerts on a new high finding, exit 2, and sends the webhook", async () => {
    const send = vi.fn(async () => ({ sent: true as const, status: 200 }));
    const deps = auditDeps([audit("old", 1, [f("a", "high")]), audit("new", 2, [f("a", "high"), f("b", "critical"), f("c", "low")])]);
    const r = await runAudits([client("example.com")], { deps, send, webhookUrl: "https://hooks.example.com/x" });
    expect(r.alerts).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(send).toHaveBeenCalledOnce();
    expect(String((send.mock.calls[0] as unknown[])[1])).toContain("new b");
  });

  it("does not alert on a first audit, and does not call the webhook", async () => {
    const send = vi.fn();
    const r = await runAudits([client("example.com")], { deps: auditDeps([audit("new", 2, [f("a", "critical")])]), send: send as never });
    expect(r.alerts).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(r.webhook).toEqual({ sent: false, reason: "no alerts" });
  });

  it("skips a failing client without failing the run", async () => {
    const stored = [audit("old", 1, []), audit("new", 2, [])];
    const r = await runAudits([client("bad.example"), client("example.com")], { deps: auditDeps(stored, ["bad.example"]) });
    expect(r.skipped).toEqual([{ client: "bad.example", reason: "error: chrome exploded" }]);
    expect(r.results).toHaveLength(1);
    expect(r.exitCode).toBe(0);
  });

  it("is an error when every client fails", async () => {
    const r = await runAudits([client("bad.example")], { deps: auditDeps([], ["bad.example"]) });
    expect(r.exitCode).toBe(1);
  });

  it("is an error when alerts cannot be delivered", async () => {
    const deps = auditDeps([audit("old", 1, []), audit("new", 2, [f("b", "high")])]);
    const send = vi.fn(async () => ({ sent: false as const, error: "Webhook timed out." }));
    const r = await runAudits([client("example.com")], { deps, send, webhookUrl: "https://hooks.example.com/x" });
    expect(r.alerts).toHaveLength(1);
    expect(r.exitCode).toBe(1);
  });

  it("dry run lists pages and runs nothing", async () => {
    const deps = { ...auditDeps([]), runAudit: vi.fn() };
    const r = await runAudits([client("example.com")], { deps, dryRun: true, urls: ["https://example.com/a"] });
    expect(deps.runAudit).not.toHaveBeenCalled();
    expect(r.results).toEqual([{ client: "example.com", wouldAudit: ["https://example.com/a"] }]);
    expect(r.exitCode).toBe(0);
  });
});

describe("discovery failures", () => {
  it("exits 1 when discovery failed and there are no clients", async () => {
    const r = await runAudits([], { deps: auditDeps([]), discoveryError: "quota exceeded" });
    expect(r.errors).toEqual(["Discovery failed and no clients are configured: quota exceeded"]);
    expect(r.exitCode).toBe(1);
  });
  it("lists the error but keeps exit 0 when yaml clients ran fine", async () => {
    const r = await runAudits([client("example.com")], { deps: auditDeps([audit("old", 1, []), audit("new", 2, [])]), discoveryError: "quota exceeded" });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("quota exceeded");
    expect(r.exitCode).toBe(0);
  });
  it("a dry run with no clients is not fatal", async () => {
    const r = await runTrafficChecks([], { thresholds: { trafficDropPct: 25, minClicksLost: 50 }, dryRun: true, discoveryError: "x" });
    expect(r.exitCode).toBe(0);
  });
});

const row = (query: string, clicks: number): GscRow => ({ keys: [query], clicks, impressions: clicks * 10, ctr: 10, position: 3 });

describe("runTrafficChecks", () => {
  const thresholds = { trafficDropPct: 25, minClicksLost: 50 };
  const today = new Date("2026-10-12T12:00:00Z");

  it("compares 7 complete days to the prior 7, splitting branded out", async () => {
    const calls: string[] = [];
    const deps = {
      gscQuery: async (_c: Client, o: { startDate: string; endDate: string }) => {
        calls.push(`${o.startDate}..${o.endDate}`);
        // Current window first: branded steady, non-branded halved.
        return calls.length === 1 ? [row("example plumbing", 100), row("fix leak", 100)] : [row("example plumbing", 100), row("fix leak", 300)];
      },
    };
    const r = await runTrafficChecks([client("exampleplumbing.com", { gscProperty: "sc-domain:exampleplumbing.com" })], { thresholds, deps, today });
    expect(calls).toEqual(["2026-10-03..2026-10-09", "2026-09-26..2026-10-02"]);
    expect(r.alerts).toEqual([expect.objectContaining({ kind: "traffic-drop", client: "exampleplumbing.com", clicksLost: 200 })]);
    expect(r.exitCode).toBe(2);
  });

  it("skips clients without Search Console and does not alert on small drops", async () => {
    const deps = { gscQuery: async () => [row("fix leak", 10)] };
    const r = await runTrafficChecks([client("nogsc.example"), client("example.com", { gscProperty: "sc-domain:example.com" })], { thresholds, deps, today });
    expect(r.skipped).toEqual([{ client: "nogsc.example", reason: "no Search Console property" }]);
    expect(r.alerts).toEqual([]);
    expect(r.exitCode).toBe(0);
  });
});
