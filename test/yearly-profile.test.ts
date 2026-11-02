/**
 * Release 0.5.0 Y0.6: page groups in clients.yaml, on the Client, in setClientProfile, the set_client_profile tool and
 * `clients set --page-group` (C3). Temp clients file and data directory only.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { env } from "../src/config.js";
import { resolveClient, setClientProfile } from "../src/clients.js";
import { setObjectList } from "../src/lib/clients-file.js";
import { mergeClients, parseOverrides, type ClientDefaults } from "../src/lib/clients.js";
import { DEFAULT_PAGE_GROUPS } from "../src/lib/page-groups.js";
import { registerCompetitorTools } from "../src/tools/competitors.js";

const DEFAULTS: ClientDefaults = { locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5 };
const YAML = `
clients:
  example:
    domain: example.com
    pageGroups: # first match wins
      - name: Blog
        prefix: [/blog/, /news/]
      - name: " Services "
        prefix: [/services/]
      - name: Product pages
        regex: ["/products/[^/]+/$"]
`;
const merged = (text: string) => mergeClients([], parseOverrides(parseYaml(text), "test"), DEFAULTS)[0]!;
const reload = () => parseYaml(readFileSync(env.CLIENTS_FILE, "utf8")).clients as Record<string, Record<string, unknown>>;

describe("clients.yaml pageGroups", () => {
  it("a file without pageGroups loads the defaults", () => {
    const c = merged("clients:\n  example:\n    domain: example.com\n");
    expect(c.pageGroupsSource).toBe("default");
    expect(c.pageGroups).toEqual(DEFAULT_PAGE_GROUPS);
    // A copy: changing it never changes the defaults.
    c.pageGroups[0]!.name = "Changed";
    expect(DEFAULT_PAGE_GROUPS[0]!.name).toBe("Home");
  });

  it("YAML groups load in order as yaml, names trimmed", () => {
    const c = merged(YAML);
    expect(c.pageGroupsSource).toBe("yaml");
    expect(c.pageGroups).toEqual([
      { name: "Blog", prefix: ["/blog/", "/news/"] },
      { name: "Services", prefix: ["/services/"] },
      { name: "Product pages", regex: ["/products/[^/]+/$"] },
    ]);
  });

  it("an invalid list is a load error naming clients.<slug>.pageGroups", () => {
    const bad = (groups: unknown) => () => parseOverrides({ clients: { example: { domain: "example.com", pageGroups: groups } } }, "test");
    expect(bad([{ name: "Other", prefix: ["/o/"] }])).toThrow(/^Invalid test: clients\.example\.pageGroups page group "Other": "Other" is the name for pages no group matches/);
    expect(bad([{ name: "Look", regex: ["/(?!x)"] }])).toThrow(/clients\.example\.pageGroups page group "Look": the regex .* lookarounds aren't supported/);
    expect(bad([{ name: "Rel", prefix: ["blog/"] }])).toThrow(/clients\.example\.pageGroups page group "Rel": the prefix "blog\/" must start with "\/"/);
    expect(bad([])).toThrow(/clients\.example\.pageGroups needs at least one page group/);
    expect(bad("blog")).toThrow(/^Invalid test: clients\.example\.pageGroups/);
    expect(bad([{ prefix: ["/a/"] }])).toThrow(/clients\.example\.pageGroups\.0\.name/);
  });

  it("is ignored by the 0.4.0 override shape (non-strict z.object strips unknown keys)", () => {
    const old = z.object({ domain: z.string().min(1), gscExcludeQueries: z.array(z.string()).optional() });
    const parsed = z.object({ clients: z.record(z.string(), old) }).parse(parseYaml(YAML));
    expect(parsed.clients.example).toEqual({ domain: "example.com" });
  });
});

describe("setObjectList", () => {
  const text = "# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n    pageGroups: # my groups\n      - name: Old\n        prefix: [/old/]\n    niche: plumber # after\n";
  it("replaces the list as block maps with inline string lists, keeping comments (the key-line one on its own line, as setStringList does)", () => {
    const out = setObjectList(text, "example.com", "pageGroups", [{ name: "Blog", prefix: ["/blog/", "/news/"] }, { name: "Product pages", regex: ["/products/[^/]+/$"] }]);
    expect(out).toBe(
      "# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n    pageGroups:\n      # my groups\n      - name: Blog\n        prefix: [ /blog/, /news/ ]\n      - name: Product pages\n        regex: [ \"/products/[^/]+/$\" ]\n    niche: plumber # after\n",
    );
    expect(parseOverrides(parseYaml(out), "test")[0]!.pageGroups).toEqual([{ name: "Blog", prefix: ["/blog/", "/news/"] }, { name: "Product pages", regex: ["/products/[^/]+/$"] }]);
  });

  it("adds the field when missing, and removes it for [] or undefined", () => {
    const bare = "clients:\n  example.com:\n    domain: example.com\n";
    expect(setObjectList(bare, "example.com", "pageGroups", [{ name: "Blog", prefix: ["/blog/"] }])).toBe("clients:\n  example.com:\n    domain: example.com\n    pageGroups:\n      - name: Blog\n        prefix: [ /blog/ ]\n");
    expect(setObjectList(text, "example.com", "pageGroups", [])).toBe("# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n    niche: plumber # after\n");
    expect(setObjectList(text, "example.com", "pageGroups", undefined)).not.toContain("pageGroups");
  });
});

describe("setClientProfile pageGroups", () => {
  const start = () => writeFileSync(env.CLIENTS_FILE, "# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n");

  it("writes the groups in order, echoes them, and [] goes back to the defaults", async () => {
    start();
    const r = await setClientProfile("example.com", { pageGroups: [{ name: " Blog ", prefix: ["/blog/"] }, { name: "Services", prefix: ["/services/"], regex: ["/svc/[0-9]+$"] }] });
    expect(r.set).toMatchObject({ pageGroups: "Blog, Services" });
    expect(r.profile.pageGroups).toEqual([{ name: "Blog", prefix: ["/blog/"] }, { name: "Services", prefix: ["/services/"], regex: ["/svc/[0-9]+$"] }]);
    expect(r.profile.pageGroupsSource).toBe("yaml");
    expect(reload()["example.com"]!.pageGroups).toEqual([{ name: "Blog", prefix: ["/blog/"] }, { name: "Services", prefix: ["/services/"], regex: ["/svc/[0-9]+$"] }]);
    expect(readFileSync(env.CLIENTS_FILE, "utf8")).toContain("# keep me");
    expect((await resolveClient("example.com")).pageGroupsSource).toBe("yaml");

    const cleared = await setClientProfile("example.com", { pageGroups: [] });
    expect(cleared.cleared).toContain("pageGroups");
    expect(cleared.profile).toMatchObject({ pageGroups: DEFAULT_PAGE_GROUPS, pageGroupsSource: "default" });
    expect(reload()["example.com"]).not.toHaveProperty("pageGroups");
  });

  it("refuses an invalid list before writing", async () => {
    start();
    await expect(setClientProfile("example.com", { pageGroups: [{ name: "Wild", prefix: ["/a*/"] }] })).rejects.toThrow(/^pageGroups: page group "Wild": the prefix "\/a\*\/" has a "\*"/);
    await expect(setClientProfile("example.com", { pageGroups: [{ name: "A", prefix: ["/a/"] }, { name: "a", prefix: ["/b/"] }] })).rejects.toThrow(/appears twice/);
    expect(reload()["example.com"]).not.toHaveProperty("pageGroups");
  });
});

describe("set_client_profile tool pageGroups", () => {
  it("accepts and describes pageGroups; [] restores the defaults", async () => {
    let def: { description: string; inputSchema: Record<string, z.ZodType> } | undefined;
    let cb: ((a: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>) | undefined;
    registerCompetitorTools({ registerTool: (name: string, d: never, c: never) => void (name === "set_client_profile" && ((def = d), (cb = c))) } as never);
    expect(def!.description).toContain("pageGroups sets the page types the yearly report sections use");
    const schema = z.object(def!.inputSchema);
    expect(schema.safeParse({ client: "example.com", pageGroups: [{ name: "Blog", prefix: ["/blog/"] }] }).success).toBe(true);
    expect(schema.safeParse({ client: "example.com", pageGroups: Array.from({ length: 13 }, (_, i) => ({ name: `G${i}`, prefix: ["/g/"] })) }).success).toBe(false);
    expect(schema.safeParse({ client: "example.com", pageGroups: [{ name: "Blog", prefix: ["/blog/"], extra: true }] }).success).toBe(false);
    writeFileSync(env.CLIENTS_FILE, "clients:\n  example.com:\n    domain: example.com\n");
    const set = await cb!({ client: "example.com", pageGroups: [{ name: "Blog", prefix: ["/blog/"] }] }, {});
    expect(JSON.parse(set.content[0]!.text).profile.pageGroups).toEqual([{ name: "Blog", prefix: ["/blog/"] }]);
    expect(reload()["example.com"]!.pageGroups).toEqual([{ name: "Blog", prefix: ["/blog/"] }]);
    const cleared = await cb!({ client: "example.com", pageGroups: [] }, {});
    expect(JSON.parse(cleared.content[0]!.text).profile).toMatchObject({ pageGroups: DEFAULT_PAGE_GROUPS, pageGroupsSource: "default" });
    expect(reload()["example.com"]).not.toHaveProperty("pageGroups");
  });
});

describe("clients set --page-group (CLI)", () => {
  const SPAWN_TIMEOUT_MS = 45_000;
  const cli = (file: string, dir: string, ...args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), "clients", "set", ...args], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, CRAWLMARK_HOME: dir, CLIENTS_FILE: file, DATA_DIR: join(dir, "data") },
    });

  it("writes prefix groups in order and keeps comments; none removes the key; malformed values are usage errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawlmark-yearly-cli-"));
    const file = join(dir, "clients.yaml");
    writeFileSync(file, "# my clients\nclients:\n  example.com:\n    domain: example.com # the site\n");
    const read = () => parseYaml(readFileSync(file, "utf8")).clients["example.com"] as Record<string, unknown>;

    const one = cli(file, dir, "example.com", "--page-group", "Blog=/blog/");
    expect(one.status, one.stderr).toBe(0);
    expect(read().pageGroups).toEqual([{ name: "Blog", prefix: ["/blog/"] }]);

    const two = cli(file, dir, "example.com", "--page-group", "Blog=/blog/, /news/", "--page-group", "Services=/services/");
    expect(two.status, two.stderr).toBe(0);
    expect(read().pageGroups).toEqual([
      { name: "Blog", prefix: ["/blog/", "/news/"] },
      { name: "Services", prefix: ["/services/"] },
    ]);
    expect(two.stdout).toContain("Page groups Blog, Services.");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# my clients");
    expect(text).toContain("domain: example.com # the site");

    const none = cli(file, dir, "example.com", "--page-group", "none");
    expect(none.status, none.stderr).toBe(0);
    expect(read()).not.toHaveProperty("pageGroups");
    expect(none.stdout).toContain("Page groups Home, Blog, Services, Locations (defaults).");

    for (const [value, message] of [
      ["Blog", /--page-group takes Name=\/prefix\/,\/prefix\//],
      ["=/blog/", /--page-group needs a name before "="/],
      ["Blog=", /--page-group Blog: give at least one prefix/],
      ["Blog=blog/", /--page-group Blog: the prefix "blog\/" must start with "\/"/],
    ] as [string, RegExp][]) {
      const r = cli(file, dir, "example.com", "--page-group", value);
      expect(r.status, value).toBe(2);
      expect(r.stderr, value).toMatch(message);
    }
    const mixed = cli(file, dir, "example.com", "--page-group", "none", "--page-group", "Blog=/blog/");
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toMatch(/none clears the list/);
    // An invalid group (validated by setClientProfile) fails without writing.
    const other = cli(file, dir, "example.com", "--page-group", "Other=/o/");
    expect(other.status).not.toBe(0);
    expect(other.stderr).toMatch(/"Other" is the name for pages no group matches/);
    expect(read()).not.toHaveProperty("pageGroups");
  }, 10 * SPAWN_TIMEOUT_MS);
});
