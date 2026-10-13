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
