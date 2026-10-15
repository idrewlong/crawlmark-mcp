/**
 * Real Lighthouse and axe in real Chrome against a local fixture site (test/helpers/fixture-site.ts). Nothing in the
 * browser path is mocked; only the client registry is, so RESTRICT_TO_CLIENT_DOMAINS has client domains to compare to.
 *
 * Loopback seam: the URL guard and the egress proxy both refuse loopback by design. These tests set the existing,
 * documented ALLOW_PRIVATE_URLS=true in the test process's own environment (the same thing restrict-redirects.test.ts
 * does). No new switch exists in src/. It is read per call and cleared in afterAll; the guard's refusal of loopback
 * is still checked below (and in url-safety.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UrlRefusedError } from "../src/lib/url-guard.js";
import { startFixtureSite, type FixtureSite } from "./helpers/fixture-site.js";

vi.mock("../src/clients.js", () => ({ loadRegistry: async () => ({ clients: [{ domain: "127.0.0.1" }] }) }));

const { runLighthouse } = await import("../src/providers/lighthouse.js");
const { runAxe } = await import("../src/providers/axe.js");
const { closeEgressProxy } = await import("../src/lib/egress-proxy.js");

// Real Lighthouse takes 10-40 s a run, more on a loaded CI runner.
const SLOW_TEST = 120_000;
let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  delete process.env.ALLOW_PRIVATE_URLS;
  delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
  await closeEgressProxy();
  await site.close();
});
beforeEach(() => {
  process.env.ALLOW_PRIVATE_URLS = "true";
  delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
});

describe("real Lighthouse", () => {
  const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100;

  it("scores a fast page and a heavy page, and the heavy one is worse", async () => {
    const fast = await runLighthouse(`${site.origin}/fast`, "mobile", { refresh: true });
    const slow = await runLighthouse(`${site.origin}/slow`, "mobile", { refresh: true });

    for (const r of [fast, slow]) {
      expect(r.formFactor).toBe("mobile");
      for (const s of Object.values(r.scores)) expect(inRange(s)).toBe(true);
      for (const v of Object.values(r.lab)) expect(Number.isFinite(v) && v >= 0).toBe(true);
    }
    expect(fast.url).toBe(`${site.origin}/fast`);
    expect(fast.scores.performance).toBeGreaterThan(slow.scores.performance);
    expect(slow.lab.fcpMs).toBeGreaterThan(fast.lab.fcpMs);
    expect(fast.scores.seo).toBeGreaterThanOrEqual(90);
    expect(fast.scores.accessibility).toBeGreaterThanOrEqual(90);

    // Opportunities: at most 8, worst first, each with an id and title, savings a number when present.
    expect(slow.opportunities.length).toBeGreaterThan(0);
    expect(slow.opportunities.length).toBeLessThanOrEqual(8);
    for (const o of slow.opportunities) {
      expect(o.id).toMatch(/^[a-z0-9-]+$/);
      expect(o.title.length).toBeGreaterThan(0);
      if (o.savingsMs !== undefined) expect(o.savingsMs).toBeGreaterThanOrEqual(0);
    }
    const savings = slow.opportunities.map((o) => o.savingsMs ?? 0);
    expect(savings).toEqual([...savings].sort((a, b) => b - a));
    expect(fast.opportunities.length).toBeLessThanOrEqual(slow.opportunities.length);
  }, SLOW_TEST * 2);

  it("runs the desktop profile", async () => {
    const r = await runLighthouse(`${site.origin}/fast`, "desktop", { refresh: true });
    expect(r.formFactor).toBe("desktop");
    expect(inRange(r.scores.performance)).toBe(true);
  }, SLOW_TEST);

  it("reports the accessibility problems on the a11y page", async () => {
    const good = await runLighthouse(`${site.origin}/fast`, "mobile");
    const bad = await runLighthouse(`${site.origin}/a11y`, "mobile", { refresh: true });
    expect(bad.scores.accessibility).toBeLessThan(good.scores.accessibility);
    expect(bad.scores.accessibility).toBeLessThan(90);
  }, SLOW_TEST * 2);

  it("follows a same-domain redirect, and keeps the URL that was asked for", async () => {
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    const r = await runLighthouse(`${site.origin}/redirect`, "mobile", { refresh: true });
    expect(r.url).toBe(`${site.origin}/redirect`);
    // Scored the redirect target (it has a title and description), not an error page.
    expect(r.scores.seo).toBeGreaterThanOrEqual(90);
    expect(r).not.toHaveProperty("finalUrl");
  }, SLOW_TEST);

  it("RESTRICT_TO_CLIENT_DOMAINS refuses a final URL on another domain, live and from the cache", async () => {
    const url = `${site.origin}/offsite`;
    // 1. Live: the page ends on localhost, which is not a client domain.
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    const err = await runLighthouse(url, "mobile", { refresh: true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(UrlRefusedError);
    expect((err as Error).message).toMatch(/Refusing a redirect to localhost/);

    // 2. Without the restriction the same page is reported, and the answer is cached with its final URL...
    delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
    const open = await runLighthouse(url, "mobile", { refresh: true });
    expect(open.scores.seo).toBeGreaterThanOrEqual(90);

    // 3. ...so turning the restriction on later still refuses it, without another run.
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    await expect(runLighthouse(url, "mobile")).rejects.toBeInstanceOf(UrlRefusedError);
  }, SLOW_TEST * 2);

  it("still refuses loopback when ALLOW_PRIVATE_URLS is off", async () => {
    delete process.env.ALLOW_PRIVATE_URLS;
    await expect(runLighthouse(`${site.origin}/fast`, "mobile", { refresh: true })).rejects.toBeInstanceOf(UrlRefusedError);
  });
});

describe("real axe", () => {
  it("finds the planted violations on the a11y page, worst first, with selectors", async () => {
    const r = await runAxe(`${site.origin}/a11y`, "AA", { refresh: true });
    const ids = r.violations.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(["html-has-lang", "image-alt", "button-name", "link-name", "label"]));
    expect(r.violations.find((v) => v.id === "image-alt")).toMatchObject({ impact: "critical", nodes: 1, examples: ["img"] });
    const order = ["critical", "serious", "moderate", "minor"];
    const ranks = r.violations.map((v) => order.indexOf(v.impact ?? "minor"));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(r.counts.critical).toBeGreaterThan(0);
    expect(r.counts.serious).toBeGreaterThan(0);
    expect(r.level).toBe("AA");
    expect(r).not.toHaveProperty("finalUrl");
  }, SLOW_TEST);

  it("finds nothing on the clean page", async () => {
    const r = await runAxe(`${site.origin}/fast`, "AA", { refresh: true });
    expect(r.violations).toEqual([]);
    expect(r.passes).toBeGreaterThan(0);
  }, SLOW_TEST);

  it("RESTRICT_TO_CLIENT_DOMAINS refuses a redirect off the client's domain, and allows one on it", async () => {
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    await expect(runAxe(`${site.origin}/offsite`, "AA", { refresh: true })).rejects.toBeInstanceOf(UrlRefusedError);
    await expect(runAxe(`${site.origin}/redirect`, "AA", { refresh: true })).resolves.toMatchObject({ violations: [] });
  }, SLOW_TEST * 2);
});
