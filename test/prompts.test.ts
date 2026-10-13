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
});
