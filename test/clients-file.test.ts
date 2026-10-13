import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { addEntry, applySync, NEW_FILE_HEADER, removeEntry, setIgnore } from "../src/lib/clients-file.js";
import { parseOverrides, type SyncPlan } from "../src/lib/clients.js";

const USER_FILE = `# My clients. Hand-edited; keep this comment.
clients:
  # Main client
  example-co:
    domain: example.com
    name: Mine # inline comment
    competitors: [rival.example]
  example.org: { domain: example.org, gscProperty: "http://example.org/" }
`;

const plan: SyncPlan = {
  add: [{ domain: "example.net", name: "Example Net", ga4PropertyId: "200000001" }],
  fill: [
    { key: "example-co", domain: "example.com", field: "ga4PropertyId", value: "99999999" },
    { key: "example-co", domain: "example.com", field: "gscProperty", value: "sc-domain:example.com" },
  ],
};

describe("applySync", () => {
  it("appends and fills while keeping every comment and user value", () => {
    const out = applySync(USER_FILE, plan);
    expect(out).toContain("# My clients. Hand-edited; keep this comment.");
    expect(out).toContain("  # Main client\n");
    expect(out).toContain("name: Mine # inline comment");
    expect(out).toContain('example.org: { domain: example.org, gscProperty: "http://example.org/" }');
    expect(out).toContain('    ga4PropertyId: "99999999"');
    expect(out).toContain('  example.net:\n    domain: example.net\n    name: Example Net\n    ga4PropertyId: "200000001"\n');

    const parsed = parseOverrides(parseYaml(out));
    expect(parsed.find((o) => o.slug === "example-co")).toEqual({
      slug: "example-co",
      domain: "example.com",
      name: "Mine",
      competitors: ["rival.example"],
      gscProperty: "sc-domain:example.com",
      ga4PropertyId: "99999999",
    });
    expect(parsed.find((o) => o.slug === "example.org")!.gscProperty).toBe("http://example.org/");
  });

  it("never replaces a value that is already set", () => {
    const out = applySync(USER_FILE, {
      add: [],
      fill: [{ key: "example.org", domain: "example.org", field: "gscProperty", value: "https://example.org/" }],
    });
    expect(parseOverrides(parseYaml(out)).find((o) => o.slug === "example.org")!.gscProperty).toBe("http://example.org/");
  });

  it("returns the text unchanged for an empty plan", () => {
    expect(applySync(USER_FILE, { add: [], fill: [] })).toBe(USER_FILE);
    expect(applySync(undefined, { add: [], fill: [] })).toBe("");
  });

  it("creates a new file with a header comment", () => {
    const out = applySync(undefined, { add: [{ domain: "example.com", gscProperty: "sc-domain:example.com" }], fill: [] });
    expect(out.startsWith(`#${NEW_FILE_HEADER.split("\n")[0]}`)).toBe(true);
    expect(parseOverrides(parseYaml(out))).toEqual([{ slug: "example.com", domain: "example.com", gscProperty: "sc-domain:example.com" }]);
  });

  it("handles a file whose clients: is empty or that is only comments", () => {
    for (const text of ["clients:\n", "# just a note\n"]) {
      const out = applySync(text, { add: [{ domain: "example.com" }], fill: [] });
      expect(parseOverrides(parseYaml(out)).map((o) => o.domain)).toEqual(["example.com"]);
    }
    expect(applySync("# just a note\n", { add: [{ domain: "example.com" }], fill: [] })).toContain("# just a note");
  });

  it("refuses invalid YAML instead of overwriting it", () => {
    expect(() => applySync("clients: [unclosed\n", plan)).toThrow(/not valid YAML/);
  });
});

describe("formatting", () => {
  it("never folds long strings", () => {
    const name = "A very long client display name that would normally be folded by the YAML serializer at eighty columns";
    const out = addEntry(undefined, { domain: "example.com", name });
    expect(out).toContain(`    name: ${name}\n`);
    expect(parseOverrides(parseYaml(out))[0]!.name).toBe(name);
  });

  it("turns a flow-style clients map into block style", () => {
    for (const text of ["clients: {}\n", "clients: { example.org: { domain: example.org } }\n"]) {
      const out = addEntry(text, { domain: "example.com" });
      expect(out).toMatch(/^clients:\n {2}/m);
      expect(out).toContain("  example.com:\n    domain: example.com\n");
      expect(parseOverrides(parseYaml(out)).map((o) => o.domain).sort()).toEqual(
        text.includes("example.org") ? ["example.com", "example.org"] : ["example.com"],
      );
    }
  });

  it("fills an empty-string property", () => {
    const text = 'clients:\n  example.com:\n    domain: example.com\n    gscProperty: ""\n';
    const out = applySync(text, {
      add: [],
      fill: [{ key: "example.com", domain: "example.com", field: "gscProperty", value: "sc-domain:example.com" }],
    });
    expect(parseOverrides(parseYaml(out))[0]!.gscProperty).toBe("sc-domain:example.com");
  });
});

describe("addEntry / removeEntry / setIgnore", () => {
  it("adds a manual entry keyed by domain, keeping comments", () => {
    const out = addEntry(USER_FILE, { domain: "manual.example", name: "Manual" });
    expect(out).toContain("# My clients. Hand-edited; keep this comment.");
    expect(parseOverrides(parseYaml(out)).find((o) => o.slug === "manual.example")).toEqual({
      slug: "manual.example",
      domain: "manual.example",
      name: "Manual",
    });
    expect(() => addEntry(out, { domain: "manual.example" })).toThrow(/already has a key/);
  });

  it("removes only the named entry", () => {
    const out = removeEntry(USER_FILE, "example.org");
    expect(parseOverrides(parseYaml(out)).map((o) => o.slug)).toEqual(["example-co"]);
    expect(out).toContain("name: Mine # inline comment");
    expect(() => removeEntry(USER_FILE, "nope")).toThrow(/no entry nope/);
    // Removing the last entry leaves `clients: {}`, not a dangling `{}` line...
    const plain = removeEntry("clients:\n  example.com:\n    domain: example.com\n", "example.com");
    expect(plain).toBe("clients: {}\n");
    expect(addEntry(plain, { domain: "example.org" })).toBe("clients:\n  example.org:\n    domain: example.org\n");
    // ...and a comment inside the map survives even when the map empties.
    const emptied = removeEntry(removeEntry(USER_FILE, "example.org"), "example-co");
    expect(emptied).toContain("# Main client");
    expect(parseOverrides(parseYaml(emptied))).toEqual([]);
  });

  it("sets and clears ignore", () => {
    const ignored = setIgnore(USER_FILE, "example-co", true);
    expect(parseOverrides(parseYaml(ignored)).find((o) => o.slug === "example-co")!.ignore).toBe(true);
    const back = setIgnore(ignored, "example-co", false);
    expect(parseOverrides(parseYaml(back)).find((o) => o.slug === "example-co")!.ignore).toBeUndefined();
    expect(addEntry(undefined, { domain: "hidden.example", ignore: true })).toContain("ignore: true");
  });
});
