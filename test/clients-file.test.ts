import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  addEntry,
  appendListItems,
  applySync,
  NEW_FILE_HEADER,
  removeEntry,
  removeListItems,
  setEntryFields,
  setIgnore,
} from "../src/lib/clients-file.js";
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

describe("list edits", () => {
  const entry = { domain: "new.example", source: "manual", addedAt: "2026-10-12" };

  it("appends to a flow list as block items, keeping comments and the plain strings", () => {
    const out = appendListItems(USER_FILE, "example-co", "competitors", [entry]);
    expect(out).toContain("# My clients. Hand-edited; keep this comment.");
    expect(out).toContain("name: Mine # inline comment");
    expect(out).toContain("    competitors:\n      - rival.example\n      - domain: new.example\n        source: manual\n        addedAt: 2026-10-12\n");
    const o = parseOverrides(parseYaml(out)).find((x) => x.slug === "example-co")!;
    expect(o.competitors).toEqual(["rival.example", entry]);
    // Other entries are untouched.
    expect(out).toContain('example.org: { domain: example.org, gscProperty: "http://example.org/" }');
  });

  it("creates the field, including on a flow-style entry and on an empty `field:`", () => {
    const a = appendListItems(USER_FILE, "example.org", "trackedKeywords", [{ keyword: "plumber near me", source: "manual" }]);
    expect(parseOverrides(parseYaml(a)).find((x) => x.slug === "example.org")!.trackedKeywords).toEqual([
      { keyword: "plumber near me", source: "manual" },
    ]);
    const b = appendListItems("clients:\n  example.com:\n    domain: example.com\n    competitors:\n", "example.com", "competitors", [entry]);
    expect(parseOverrides(parseYaml(b))[0]!.competitors).toEqual([entry]);
  });

  it("keeps addedAt a string when read back", () => {
    const out = appendListItems(USER_FILE, "example-co", "competitors", [entry]);
    const raw = parseYaml(out) as { clients: { "example-co": { competitors: unknown[] } } };
    expect(raw.clients["example-co"].competitors[1]).toEqual(entry);
  });

  it("returns the text unchanged when there is nothing to add or remove", () => {
    expect(appendListItems(USER_FILE, "example-co", "competitors", [])).toBe(USER_FILE);
    expect(removeListItems(USER_FILE, "example-co", "competitors", [])).toBe(USER_FILE);
  });

  it("refuses a missing entry or a field that isn't a list", () => {
    expect(() => appendListItems(USER_FILE, "nope", "competitors", [entry])).toThrow(/no entry nope/);
    expect(() => appendListItems("clients:\n  a:\n    domain: example.com\n    competitors: rival.example\n", "a", "competitors", [entry])).toThrow(
      /not a list/,
    );
  });

  it("removes items by index and drops a list left empty", () => {
    const two = appendListItems(USER_FILE, "example-co", "competitors", [entry]);
    const one = removeListItems(two, "example-co", "competitors", [0]);
    expect(parseOverrides(parseYaml(one)).find((x) => x.slug === "example-co")!.competitors).toEqual([entry]);
    const none = removeListItems(one, "example-co", "competitors", [0]);
    expect(none).not.toContain("competitors");
    expect(none).toContain("name: Mine # inline comment");
    expect(() => removeListItems(one, "example-co", "competitors", [5])).toThrow(/no item 5/);
  });
});

describe("setEntryFields", () => {
  it("sets, replaces and clears fields without touching others", () => {
    const set = setEntryFields(USER_FILE, "example-co", { area: "Austin,Texas,United States", niche: "emergency plumber", name: undefined });
    const o = parseOverrides(parseYaml(set)).find((x) => x.slug === "example-co")!;
    expect(o.area).toBe("Austin,Texas,United States");
    expect(o.niche).toBe("emergency plumber");
    expect(o.name).toBe("Mine");
    expect(set).toContain("name: Mine # inline comment");
    const cleared = setEntryFields(set, "example-co", { niche: "", name: "New Name" });
    const c = parseOverrides(parseYaml(cleared)).find((x) => x.slug === "example-co")!;
    expect(c.niche).toBeUndefined();
    expect(c.name).toBe("New Name");
    expect(c.area).toBe("Austin,Texas,United States");
  });
});
