import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THRESHOLDS, exitCodeFor, findingAlerts, formatAlertText, trafficAlert, type Alert } from "../src/analysis/alerts.js";
import type { Finding } from "../src/analysis/findings.js";
import { sendWebhook } from "../src/lib/webhook.js";

const finding = (severity: Finding["severity"], rule = "r", url = "https://example.com/"): Finding => ({
  id: `${rule}-${severity}`,
  source: "onpage",
  rule,
  url,
  severity,
  title: `title ${rule}`,
});

describe("findingAlerts", () => {
  it("alerts on new critical and high findings only", () => {
    const alerts = findingAlerts("example.com", [finding("critical", "a"), finding("high", "b"), finding("medium", "c"), finding("low", "d")]);
    expect(alerts.map((a) => (a.kind === "new-finding" ? a.rule : ""))).toEqual(["a", "b"]);
  });
  it("is empty for no findings", () => expect(findingAlerts("example.com", [])).toEqual([]));
});

describe("trafficAlert", () => {
  const t = DEFAULT_THRESHOLDS;
  it("alerts at the percent and absolute thresholds", () => {
    expect(trafficAlert("example.com", 200, 150, t)).toMatchObject({ kind: "traffic-drop", clicksLost: 50, dropPct: 25 });
  });
  it("does not alert on a big percent drop with few clicks lost", () => {
    expect(trafficAlert("example.com", 40, 10, t)).toBeNull();
  });
  it("does not alert on many clicks lost with a small percent drop", () => {
    expect(trafficAlert("example.com", 1000, 900, t)).toBeNull();
  });
  it("does not alert on growth, no change, or no baseline", () => {
    expect(trafficAlert("example.com", 100, 200, t)).toBeNull();
    expect(trafficAlert("example.com", 100, 100, t)).toBeNull();
    expect(trafficAlert("example.com", 0, 0, t)).toBeNull();
  });
  it("honours custom thresholds", () => {
    expect(trafficAlert("example.com", 100, 90, { trafficDropPct: 10, minClicksLost: 5 })).not.toBeNull();
  });
});

describe("exitCodeFor", () => {
  it("is 0 clean, 2 with alerts, and 1 on error even with alerts", () => {
    expect(exitCodeFor({ alerts: 0, failed: false })).toBe(0);
    expect(exitCodeFor({ alerts: 3, failed: false })).toBe(2);
    expect(exitCodeFor({ alerts: 0, failed: true })).toBe(1);
    expect(exitCodeFor({ alerts: 3, failed: true })).toBe(1);
  });
});

describe("formatAlertText", () => {
  it("is empty without alerts", () => expect(formatAlertText([])).toBe(""));
  it("summarises findings and traffic, without query strings", () => {
    const alerts: Alert[] = [
      ...findingAlerts("example.com", [finding("critical", "not-indexed", "https://example.com/p?token=secret#x")]),
      { kind: "traffic-drop", client: "example.org", previousClicks: 400, currentClicks: 200, clicksLost: 200, dropPct: 50 },
    ];
    const text = formatAlertText(alerts);
    expect(text).toContain("2 alerts");
    expect(text).toContain("[critical] example.com: new not-indexed on https://example.com/p");
    expect(text).toContain("non-branded clicks down 50% (400 to 200, 200 lost)");
    expect(text).not.toContain("secret");
  });
  it("escapes mrkdwn control characters in titles", () => {
    const f2: Finding = { id: "x", source: "onpage", rule: "r", url: "https://example.com/", severity: "high", title: "<!channel> a & b" };
    const text = formatAlertText(findingAlerts("example.com", [f2]));
    expect(text).toContain("&lt;!channel&gt; a &amp; b");
    expect(text).not.toContain("<!channel>");
  });
  it("caps the list", () => {
    const many = findingAlerts("example.com", Array.from({ length: 30 }, (_, i) => finding("high", `r${i}`)));
    const text = formatAlertText(many);
    expect(text.split("\n")).toHaveLength(1 + 15 + 1);
    expect(text).toContain("...and 15 more");
  });
});

describe("sendWebhook", () => {
  const ok = () => vi.fn(async () => ({ ok: true, status: 200 }));
  it("sends nothing without alert text", async () => {
    const fetch = ok();
    expect(await sendWebhook("https://hooks.example.com/x", "", { fetch })).toEqual({ sent: false, reason: "no alerts" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends nothing without a URL", async () => {
    const fetch = ok();
    expect(await sendWebhook(undefined, "hi", { fetch })).toMatchObject({ sent: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("posts {text} as JSON with a timeout signal", async () => {
    const fetch = ok();
    expect(await sendWebhook("https://hooks.example.com/x", "hello", { fetch, env: {} })).toEqual({ sent: true, status: 200 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/x");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("refuses http unless ALLOW_PRIVATE_URLS is set", async () => {
    const fetch = ok();
    const r = await sendWebhook("http://hooks.example.com/x", "hi", { fetch, env: {} });
    expect(r).toMatchObject({ sent: false, error: expect.stringContaining("https") });
    expect(fetch).not.toHaveBeenCalled();
    expect(await sendWebhook("http://127.0.0.1:9/x", "hi", { fetch, env: { ALLOW_PRIVATE_URLS: "true" } })).toMatchObject({ sent: true });
  });
  it("refuses private hosts", async () => {
    const fetch = ok();
    expect(await sendWebhook("https://10.0.0.5/x", "hi", { fetch, env: {} })).toMatchObject({ sent: false, error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports failures without leaking the URL", async () => {
    const secretUrl = "https://hooks.example.com/services/SECRET123";
    const boom = vi.fn(async () => {
      throw new Error(`connect failed for ${secretUrl}`);
    });
    const r = await sendWebhook(secretUrl, "hi", { fetch: boom, env: {} });
    expect(JSON.stringify(r)).not.toContain("SECRET123");
    expect(r).toMatchObject({ sent: false });
    const bad = await sendWebhook("not a url SECRET123", "hi", { fetch: ok(), env: {} });
    expect(JSON.stringify(bad)).not.toContain("SECRET123");
    const http500 = await sendWebhook(secretUrl, "hi", { fetch: async () => ({ ok: false, status: 500 }), env: {} });
    expect(http500).toEqual({ sent: false, error: "Webhook returned HTTP 500." });
  });
});
