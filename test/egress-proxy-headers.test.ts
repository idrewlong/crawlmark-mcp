import { describe, expect, it } from "vitest";
import { stripHopByHop } from "../src/lib/egress-proxy.js";

describe("stripHopByHop", () => {
  it("drops hop-by-hop and Connection-listed headers, keeps the rest", () => {
    const out = stripHopByHop({ connection: "x-private, keep-alive", "x-private": "1", "keep-alive": "5", accept: "text/html", host: "example.com" });
    expect(Object.keys(out).sort()).toEqual(["accept", "host"]);
  });

  it("builds a prototype-less object, so a __proto__ header is only a key", () => {
    const incoming = JSON.parse('{"__proto__":"x","constructor":"y","accept":"z"}') as Record<string, string>;
    const out = stripHopByHop(incoming);
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.keys(out).sort()).toEqual(["__proto__", "accept", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe("x");
  });
});
