import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/prompts/index.js";

describe("prompt templates", () => {
  it("fills placeholders and leaves unknown ones", () => {
    expect(renderTemplate("Client {{client}} / {{other}}", { client: "example.com" })).toBe("Client example.com / {{other}}");
  });

  it("find-competitors walks through profile, suggest, confirm, add", () => {
    const text = renderTemplate(readFileSync(new URL("../src/prompts/templates/find-competitors.md", import.meta.url), "utf8"), {
      client: "example.com",
    });
    expect(text).not.toContain("{{");
    const order = ["set_client_profile", "suggest_competitors", "Ask", "add_competitors"].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('source: "suggested"');
  });

  it("review-brand-terms suggests, asks, then adds with source suggested, never across clients", () => {
    const raw = readFileSync(new URL("../src/prompts/templates/review-brand-terms.md", import.meta.url), "utf8");
    const text = renderTemplate(raw, { scope: "the client `example.com`", client: "example.com" });
    expect(text).not.toContain("{{");
    const order = ["suggest_brand_terms", "Ask", "add_brand_terms"].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('source: "suggested"');
    expect(text).toContain("other-client-brand");
    expect(text).toContain("remove_brand_terms");
    // Paid fallback for sparse Search Console data only after the user agrees.
    expect(text.indexOf("ask me whether to spend")).toBeGreaterThan(-1);
    expect(text.indexOf("ask me whether to spend")).toBeLessThan(text.indexOf("allowPaid: true"));
  });
});
