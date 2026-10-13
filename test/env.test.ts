import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stripEmptyValues } from "../src/lib/env.js";

describe("stripEmptyValues", () => {
  it("drops empty and whitespace-only values and keeps the rest", () => {
    expect(stripEmptyValues({ A: "", B: "  ", C: "x", D: undefined })).toEqual({ C: "x" });
  });

  it("lets optional and default schema fields treat empty values as unset", () => {
    const schema = z.object({
      PSI_API_KEY: z.string().optional(),
      DATAFORSEO_BASE_URL: z.string().url().default("https://sandbox.dataforseo.com/v3"),
    });
    const parsed = schema.parse(stripEmptyValues({ PSI_API_KEY: "", DATAFORSEO_BASE_URL: "" }));
    expect(parsed.PSI_API_KEY).toBeUndefined();
    expect(parsed.DATAFORSEO_BASE_URL).toBe("https://sandbox.dataforseo.com/v3");
  });
});

describe("placeholders and DataForSEO mode", () => {
  it("treats an unsubstituted bundle placeholder as unset", () => {
    expect(stripEmptyValues({ PSI_API_KEY: "${user_config.psi_api_key}", REAL: "a${b}" })).toEqual({ REAL: "a${b}" });
  });

  it("DATAFORSEO_LIVE vs DATAFORSEO_BASE_URL: the shell checkbox beats a URL from .env, in both directions", async () => {
    const { dataForSeoBaseUrl: f, DFS_LIVE_URL: LIVE, DFS_SANDBOX_URL: SBX } = await import("../src/lib/env.js");
    const shell = (baseUrl?: string, live?: string) => f({ baseUrl, baseUrlFromFile: false, live, liveFromFile: false });
    // .env URL (as the wizard writes it) with the form value from the shell
    const withFileUrl = (url: string, live?: string) => f({ baseUrl: url, baseUrlFromFile: true, live, liveFromFile: false });
    expect(withFileUrl(LIVE, "false")).toBe(SBX); // .env live URL + LIVE=false -> sandbox
    expect(withFileUrl(SBX, "true")).toBe(LIVE); // .env sandbox URL + LIVE=true -> live
    expect(withFileUrl(LIVE, undefined)).toBe(LIVE); // no checkbox: .env URL stands
    expect(withFileUrl(SBX, undefined)).toBe(SBX);
    // explicit shell URL wins over live=true, and over false
    expect(shell("https://proxy.example.com/v3", "true")).toBe("https://proxy.example.com/v3");
    expect(shell(LIVE, "false")).toBe(LIVE);
    // no URL at all
    expect(shell(undefined, "true")).toBe(LIVE);
    expect(shell(undefined, "false")).toBe(SBX);
    expect(shell(undefined, undefined)).toBe(SBX);
    // LIVE written in .env does not override a URL in .env
    expect(f({ baseUrl: "https://proxy.example.com/v3", baseUrlFromFile: true, live: "true", liveFromFile: true })).toBe("https://proxy.example.com/v3");
  });

  it("accepts TRUE, 1/0 and yes/no, and treats junk as unset instead of crashing", async () => {
    const { dataForSeoBaseUrl: f, parseBoolish, DFS_LIVE_URL: LIVE, DFS_SANDBOX_URL: SBX } = await import("../src/lib/env.js");
    for (const v of ["TRUE", "1", "yes", " Yes "]) expect(parseBoolish(v), v).toBe(true);
    for (const v of ["False", "0", "no", "NO"]) expect(parseBoolish(v), v).toBe(false);
    expect(parseBoolish("maybe")).toBeUndefined();
    expect(f({ baseUrl: undefined, baseUrlFromFile: false, live: "1", liveFromFile: false })).toBe(LIVE);
    expect(f({ baseUrl: undefined, baseUrlFromFile: false, live: "maybe", liveFromFile: false })).toBe(SBX);
  });

  it("isUnsetValue: empty, blank or a leftover placeholder", async () => {
    const { isUnsetValue } = await import("../src/lib/env.js");
    expect(["", "  ", undefined, "${user_config.chrome_path}"].every(isUnsetValue)).toBe(true);
    expect(isUnsetValue("/usr/bin/chrome")).toBe(false);
  });
});
