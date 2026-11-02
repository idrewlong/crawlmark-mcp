import { describe, expect, it } from "vitest";
import { ALL_HOSTNAMES, defaultGa4Hostnames, ga4HostnameRegex, hostnameAllowed, validateGa4Hostnames } from "../src/lib/ga4-hostnames.js";

describe("defaultGa4Hostnames", () => {
  it("is the domain and its www form, without doubling www", () => {
    expect(defaultGa4Hostnames("example.com")).toEqual(["example.com", "www.example.com"]);
    expect(defaultGa4Hostnames("www.example.com")).toEqual(["example.com", "www.example.com"]);
  });
});

describe("validateGa4Hostnames", () => {
  it("accepts hosts, wildcards, localhost and a lone *", () => {
    expect(validateGa4Hostnames(["example.com", "www.example.com", "shop.example.com"])).toBeNull();
    expect(validateGa4Hostnames(["*.example.com"])).toBeNull();
    expect(validateGa4Hostnames(["localhost"])).toBeNull();
    expect(validateGa4Hostnames([ALL_HOSTNAMES])).toBeNull();
    expect(validateGa4Hostnames(["Shop.Example.com"])).toBeNull();
  });
  it("rejects * mixed with others, bad hosts, empty and oversized lists", () => {
    expect(validateGa4Hostnames(["*", "example.com"])).toMatch(/only entry/);
    expect(validateGa4Hostnames(["https://example.com"])).toMatch(/isn't a usable GA4 hostname/);
    expect(validateGa4Hostnames(["example"])).toMatch(/isn't a usable/);
    expect(validateGa4Hostnames(["a..example.com"])).toMatch(/isn't a usable/);
    expect(validateGa4Hostnames(["*.*.example.com"])).toMatch(/isn't a usable/);
    expect(validateGa4Hostnames(["exa mple.com"])).toMatch(/isn't a usable/);
    expect(validateGa4Hostnames([`${"a".repeat(250)}.example.com`])).toMatch(/isn't a usable/);
    expect(validateGa4Hostnames([])).toMatch(/at least one/);
    expect(validateGa4Hostnames(Array.from({ length: 21 }, (_, i) => `h${i}.example.com`))).toMatch(/most allowed is 20/);
  });
});

describe("ga4HostnameRegex", () => {
  it("escapes dots and other regex characters", () => {
    expect(ga4HostnameRegex(["example.com", "www.example.com"])).toBe("example\\.com|www\\.example\\.com");
    expect(ga4HostnameRegex(["a+b.example.com"])).toBe("a\\+b\\.example\\.com");
  });
  it("expands *. to any subdomain and lowercases", () => {
    expect(ga4HostnameRegex(["*.Example.com"])).toBe("([a-z0-9-]+\\.)+example\\.com");
  });
  it("is null for * alone", () => {
    expect(ga4HostnameRegex(["*"])).toBeNull();
  });
  it("matches the same hosts as hostnameAllowed (JS full match)", () => {
    const items = ["example.com", "www.example.com", "*.shop.example.com"];
    const re = new RegExp(`^(?:${ga4HostnameRegex(items)})$`, "i");
    for (const h of ["example.com", "www.example.com", "a.shop.example.com", "a.b.shop.example.com", "shop.example.com", "staging.example.com", "exampleXcom", "old-example.com", "localhost", "(not set)"]) {
      expect(re.test(h), h).toBe(hostnameAllowed(h, items));
    }
  });
});

describe("hostnameAllowed", () => {
  it("default pair excludes subdomains and other domains", () => {
    const d = defaultGa4Hostnames("example.com");
    expect(hostnameAllowed("example.com", d)).toBe(true);
    expect(hostnameAllowed("WWW.example.com", d)).toBe(true);
    expect(hostnameAllowed("staging.example.com", d)).toBe(false);
    expect(hostnameAllowed("old-example.com", d)).toBe(false);
    expect(hostnameAllowed("(not set)", d)).toBe(false);
  });
  it("*.example.com matches subdomains but not the apex", () => {
    expect(hostnameAllowed("shop.example.com", ["*.example.com"])).toBe(true);
    expect(hostnameAllowed("a.b.example.com", ["*.example.com"])).toBe(true);
    expect(hostnameAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostnameAllowed("badexample.com", ["*.example.com"])).toBe(false);
  });
  it("* allows everything", () => {
    expect(hostnameAllowed("(not set)", ["*"])).toBe(true);
  });
});
