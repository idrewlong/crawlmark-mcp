/** SEC-2 (Phase 12 B fix round): competitor domains are plain host names; `, ; & = *` and odd dots/hyphens are refused. */
import { describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { isPlainDomain, normalizeCompetitorDomain } from "../src/lib/clients.js";
import { gapCompetitors } from "../src/providers/seo-data.js";

const client = { domain: "example.com", competitors: [] } as unknown as Pick<Client, "domain" | "competitors">;

describe("competitor domain syntax", () => {
  it("normalizeCompetitorDomain keeps plain hosts (IDNs as punycode) and refuses smuggled syntax", () => {
    expect(normalizeCompetitorDomain("https://www.Rival.example/page")).toBe("rival.example");
    expect(normalizeCompetitorDomain("bücher.example")).toBe("xn--bcher-kva.example");
    for (const bad of ["a.example,b.example", "a.example;b.example", "a&b.example", "a=b.example", "*.example", "-a.example", "a-.example", "a..example", "localhost"]) {
      expect(normalizeCompetitorDomain(bad), bad).toBeUndefined();
    }
    expect(isPlainDomain("competitor-a.example")).toBe(true);
  });

  it("keyword_gap competitors refuse the same, with the domain in the message", () => {
    expect(gapCompetitors(client, ["competitor-a.example"])).toEqual(["competitor-a.example"]);
    for (const bad of ["a.example,b.example", "x.example|-|or|y.example", "a=b.example", "*.example"]) {
      expect(() => gapCompetitors(client, [bad]), bad).toThrow(`"${bad}" isn't a domain.`);
    }
  });

  it("saved competitors that aren't plain domains are left out of the default list", () => {
    expect(gapCompetitors({ domain: "example.com", competitors: ["ok.example", "bad,one.example"] } as never, undefined)).toEqual(["ok.example"]);
  });
});
