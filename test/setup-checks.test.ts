import { describe, expect, it, vi } from "vitest";
import { checkDataForSeoCredentials } from "../src/providers/dataforseo.js";
import { checkPsiKey, classifyPsiResponse } from "../src/setup/checks.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("checkDataForSeoCredentials", () => {
  it("calls the free user_data endpoint with basic auth and returns mode and balance", async () => {
    const fetchImpl = vi.fn(async () => json(200, { status_code: 20000, status_message: "Ok.", cost: 0, tasks: [{ id: "1", status_code: 20000, status_message: "Ok.", cost: 0, result: [{ money: { balance: 3.5, total: 10 } }] }] }));
    const r = await checkDataForSeoCredentials({ login: "a@example.com", password: "pw", baseUrl: "https://sandbox.dataforseo.com/v3" }, fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ credentialsWork: true, mode: "sandbox", balanceUsd: 3.5, costUsd: 0 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox.dataforseo.com/v3/appendix/user_data");
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("a@example.com:pw").toString("base64"));
  });

  it("invalid credentials are rejected (credentialsWork false) and the error never contains them", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const r = await checkDataForSeoCredentials({ login: "a@example.com", password: "s3cret", baseUrl: "https://api.dataforseo.com/v3" }, fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ credentialsWork: false, mode: "live" });
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it("a network failure leaves the credentials untested", async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    const r = await checkDataForSeoCredentials({ login: "a", password: "b", baseUrl: "https://sandbox.dataforseo.com/v3" }, fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ credentialsWork: null, reachable: false });
  });
});

describe("PageSpeed key check", () => {
  it("classifies responses", () => {
    expect(classifyPsiResponse(200, "{}")).toEqual({ ok: true });
    expect(classifyPsiResponse(400, JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }))).toMatchObject({ ok: false, problem: expect.stringContaining("isn't valid") });
    expect(classifyPsiResponse(403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "PageSpeed Insights API has not been used in project 1 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] } }))).toMatchObject({ ok: false, problem: expect.stringContaining("isn't enabled") });
    expect(classifyPsiResponse(429, "{}")).toMatchObject({ ok: false, problem: expect.stringContaining("quota") });
    expect(classifyPsiResponse(500, JSON.stringify({ error: { message: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST" } }))).toMatchObject({ ok: true });
  });

  it("sends one request with the key and never puts the key in an error", async () => {
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await checkPsiKey("KEY123", ok as unknown as typeof fetch)).toEqual({ ok: true });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(String((ok.mock.calls[0] as unknown as [string])[0])).toContain("key=KEY123");
    const down = vi.fn(async () => Promise.reject(new TypeError("fetch failed for https://x?key=KEY123")));
    const r = await checkPsiKey("KEY123", down as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("KEY123");
  });
});
