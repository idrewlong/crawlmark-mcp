import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandPath, InvalidHomeError, isAnchoredPath, resolveHome, sourceCheckoutMarker } from "../src/lib/home.js";

const ROOT = "/opt/crawlmark";
const base = { projectRoot: ROOT, userHome: "/home/u", cwd: "/work" };
const existing = (...paths: string[]) => (p: string) => paths.map((x) => join(ROOT, x)).includes(p);

describe("resolveHome", () => {
  it("CRAWLMARK_HOME wins over everything, with ~ and relative paths expanded", () => {
    const all = existing(".git", "src", "dist", ".env", "config/clients.yaml");
    expect(resolveHome({ ...base, crawlmarkHome: "/srv/cm", exists: all })).toMatchObject({ dir: "/srv/cm", source: "env" });
    expect(resolveHome({ ...base, crawlmarkHome: "~/cm", exists: all }).dir).toBe("/home/u/cm");
  });

  it("refuses a relative CRAWLMARK_HOME (it would load the .env of whatever directory you're in)", () => {
    for (const v of ["rel/cm", ".", "./x", "~user/x"]) {
      expect(() => resolveHome({ ...base, crawlmarkHome: v, exists: () => false }), v).toThrow(InvalidHomeError);
    }
    expect(isAnchoredPath("~")).toBe(true);
    expect(isAnchoredPath("/abs")).toBe(true);
    expect(isAnchoredPath("x")).toBe(false);
  });

  it("an empty CRAWLMARK_HOME counts as unset", () => {
    expect(resolveHome({ ...base, crawlmarkHome: "  ", exists: existing(".git") }).source).toBe("project");
  });

  it("uses the project root for a source checkout: .git, src/ next to dist/, .env or config/clients.yaml", () => {
    for (const markers of [[".git"], ["src", "dist"], [".env"], ["config/clients.yaml"]]) {
      const h = resolveHome({ ...base, crawlmarkHome: undefined, exists: existing(...markers) });
      expect(h, markers.join("+")).toMatchObject({ dir: ROOT, source: "project" });
    }
  });

  it("falls back to ~/.crawlmark for an installed package", () => {
    expect(resolveHome({ ...base, crawlmarkHome: undefined, exists: existing("dist") })).toMatchObject({ dir: "/home/u/.crawlmark", source: "user" });
    // src/ alone (without dist/) is not a checkout marker.
    expect(resolveHome({ ...base, crawlmarkHome: undefined, exists: existing("src") }).source).toBe("user");
  });

  it("never treats a package inside node_modules as a checkout", () => {
    const root = "/app/node_modules/crawlmark-mcp";
    expect(sourceCheckoutMarker(root, () => true)).toBeUndefined();
    expect(resolveHome({ projectRoot: root, userHome: "/home/u", cwd: "/", crawlmarkHome: undefined, exists: () => true }).source).toBe("user");
  });

  it("expandPath handles ~, absolute and relative", () => {
    expect(expandPath("~", "/home/u", "/w")).toBe("/home/u");
    expect(expandPath("/a/../b", "/home/u", "/w")).toBe("/b");
    expect(expandPath("x", "/home/u", "/w")).toBe("/w/x");
  });
});
