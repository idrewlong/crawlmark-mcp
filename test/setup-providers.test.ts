/**
 * Phase 9 setup: the Ahrefs/Semrush credential steps, the provider pick and default
 * phases, and their status rows. Fake fetch, scripted prompts, recording Ui and a
 * temp home; nothing reaches the network or a real config.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readEnvFile } from "../src/lib/env-file.js";
import { autoPrompter, type Choice, type Prompter } from "../src/setup/prompter.js";
import { ahrefsRow, type IntegrationId, type IntegrationStatus, type SetupStatusReport } from "../src/setup/status.js";
import { recordingUi } from "../src/setup/ui.js";
import { renderStatus } from "../src/setup/status-render.js";
import { collectSetupStatus, seoProviderRow, type StatusProviders } from "../src/setup/status.js";
import { checkAhrefsKey } from "../src/providers/ahrefs.js";
import { spawnSync } from "node:child_process";
import { semrushRow } from "../src/setup/status.js";
import { runWizard, summarize, stepAhrefs, stepDataForSeo, stepSemrush, stepProviderDefault, stepProviderPick, type WizardContext } from "../src/setup/wizard.js";
import { writeFileSync } from "node:fs";
import { POSIX_MODES } from "./platform.js";

const SENTINEL = "SENTINEL-provider-key-7d41";
const LIMITS = readFileSync(new URL("./fixtures/ahrefs/limits-and-usage.json", import.meta.url), "utf8");

type Answer = string | boolean | string[];

function scripted(answers: Answer[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (q: string): Answer => {
    asked.push(q);
    if (!answers.length) throw new Error(`Unexpected question: ${q}`);
    return answers.shift()!;
  };
  return {
    asked,
    ask: async (q, o = {}) => {
      const a = next(q) as string;
      return a === "" ? (o.default ?? "") : a;
    },
    secret: async (q) => next(q) as string,
    confirm: async (q) => next(q) as boolean,
    choose: async <T extends string>(q: string, _c: readonly Choice<T>[], d: T) => ((next(q) as string) || d) as T,
    multiselect: async <T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) => {
      const a = next(q);
      return (Array.isArray(a) ? a : [...d]) as T[];
    },
    close() {},
  };
}

interface Harness {
  ctx: WizardContext;
  lines: string[];
  ui: ReturnType<typeof recordingUi>;
  fetch: ReturnType<typeof vi.fn>;
  states: Map<IntegrationId, IntegrationStatus>;
  home: string;
  env: () => Record<string, string>;
}

/** A wizard context over a temp home. `respond` answers the fake fetch (by URL). */
function harness(prompt: Prompter, opts: { respond?: (url: URL) => Response; dryRun?: boolean; fancy?: boolean } = {}): Harness {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-provsetup-")));
  const home = join(base, "home");
  mkdirSync(home);
  const lines: string[] = [];
  const states = new Map<IntegrationId, IntegrationStatus>();
  const ui = recordingUi({ fancy: opts.fancy ?? false });
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
    return opts.respond ? opts.respond(url) : new Response("not found", { status: 404 });
  });
  const ctx: WizardContext = {
    prompt,
    out: (l = "") => lines.push(l),
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    cli: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    fetch: fetch as unknown as typeof globalThis.fetch,
    status: async (only: IntegrationId[]): Promise<SetupStatusReport> => ({
      home: { dir: home, source: "env", reason: "test", envFile: join(home, ".env"), envFileExists: existsSync(join(home, ".env")) },
      cli: "crawlmark-cli",
      integrations: only.map((id) => states.get(id) ?? { id, label: id, state: "missing", detail: `${id} not set up`, next: "crawlmark-cli setup" }),
      summary: { working: 0, configured: 0, missing: 0, error: 0 },
      checkedAt: "",
      fromCache: false,
      costUsd: 0,
    }),
    checkKeyFile: vi.fn(),
    paths: { home, homeSource: "env", projectRoot: base, envFile: join(home, ".env"), userHome: base, cwd: base, desktopConfig: undefined },
    ui,
    node: { version: "v24.1.0", execPath: "/usr/local/bin/node" },
    cliDisplay: "crawlmark-cli",
    shellEnvKeys: new Set(),
    dryRun: opts.dryRun ?? false,
  };
  return { ctx, lines, ui, fetch, states, home, env: () => readEnvFile(join(home, ".env")) };
}

const ahrefsServer = (status: number) => (url: URL) => {
  if (url.pathname.endsWith("/subscription-info/limits-and-usage")) {
    return status === 200 ? new Response(LIMITS, { status: 200 }) : new Response(JSON.stringify({ error: "Invalid API key" }), { status });
  }
  return new Response("not found", { status: 404 });
};

/** Everything the run printed or recorded, for leak checks. */
const transcript = (h: Harness) => [...h.lines, ...h.ui.events].join("\n");

describe("stepAhrefs", () => {
  it("working: masked key prompt, a spinner, a success line with plan and units, saved 0600", async () => {
    const p = scripted([true, SENTINEL]);
    const h = harness(p, { respond: ahrefsServer(200) });
    const r = await stepAhrefs(h.ctx);
    expect(r).toMatchObject({ step: "ahrefs", outcome: "done" });
    expect(p.asked).toEqual(["Set up Ahrefs now?", "Ahrefs API key"]);
    expect(h.ui.events).toContain("spin: Checking with Ahrefs (free limits-and-usage call)...");
    expect(h.ui.events).toContain("success: Ahrefs works  plan Standard, key 1,200 of 50,000 units used (resets 2026-11-01)");
    expect(h.env()).toEqual({ AHREFS_API_KEY: SENTINEL });
    if (POSIX_MODES) expect((await import("node:fs")).statSync(join(h.home, ".env")).mode & 0o777).toBe(0o600);
    expect(h.ctx.providers?.working.has("ahrefs")).toBe(true);
    expect(transcript(h)).not.toContain(SENTINEL);
  });

  it("rejected: asks again, at most 3 attempts, and saves nothing", async () => {
    const p = scripted([true, "bad-1", "bad-2", "bad-3"]);
    const h = harness(p, { respond: ahrefsServer(401) });
    const r = await stepAhrefs(h.ctx);
    expect(r).toMatchObject({ outcome: "failed", message: "No working Ahrefs key after 3 attempts." });
    expect(h.ui.events.filter((e) => e === "fail: Ahrefs rejected that key. Create one under Account settings > API keys (workspace owner or admin).")).toHaveLength(3);
    expect(existsSync(join(h.home, ".env"))).toBe(false);
  });

  it("unreachable: saves the untested key only on yes", async () => {
    const down = () => new Response("", { status: 503 });
    const no = harness(scripted([true, SENTINEL, false]), { respond: down });
    expect(await stepAhrefs(no.ctx)).toMatchObject({ outcome: "failed", message: "Ahrefs unreachable; nothing saved." });
    expect(existsSync(join(no.home, ".env"))).toBe(false);

    const yes = harness(scripted([true, SENTINEL, true]), { respond: down });
    expect(await stepAhrefs(yes.ctx)).toMatchObject({ outcome: "done", message: expect.stringContaining("untested") });
    expect(yes.env()).toEqual({ AHREFS_API_KEY: SENTINEL });
    expect(yes.ctx.providers?.working.has("ahrefs") ?? false).toBe(false);
  });

  it("--yes never prompts for the key: skipped with 'needs a key'", async () => {
    const h = harness(autoPrompter(() => {}));
    expect(await stepAhrefs(h.ctx)).toEqual({ step: "ahrefs", outcome: "skipped", message: "Ahrefs needs a key; run crawlmark-cli setup --step ahrefs" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("a dry run checks the key but writes nothing", async () => {
    const h = harness(scripted([true, SENTINEL]), { respond: ahrefsServer(200), dryRun: true });
    expect(await stepAhrefs(h.ctx)).toMatchObject({ outcome: "done" });
    expect(existsSync(join(h.home, ".env"))).toBe(false);
    expect(h.ui.events).toContain(`info: Dry run: would set AHREFS_API_KEY in ${join(h.home, ".env")} (mode 0600).`);
  });
});

describe("the ahrefs status row", () => {
  const next = "crawlmark-cli setup --step ahrefs";
  const noKey = { configured: false, works: false as const, reachable: true, error: "AHREFS_API_KEY is not set.", costUsd: 0 as const };
  const usage = { unitsUsedThisMonth: 1234, cap: 50_000 };

  it("missing when there's no key and nobody uses Ahrefs; error when it's chosen but has no key", () => {
    expect(ahrefsRow({ check: noKey, chosen: { byDefault: false, clients: 0 }, ...usage }, next)).toMatchObject({ state: "missing", next });
    expect(ahrefsRow({ check: noKey, chosen: { byDefault: true, clients: 0 }, ...usage }, next)).toMatchObject({ state: "error", detail: expect.stringContaining("the default provider"), data: { default: true } });
    expect(ahrefsRow({ check: noKey, chosen: { byDefault: false, clients: 2 }, ...usage }, next)).toMatchObject({ state: "error", detail: expect.stringContaining("2 client(s)") });
  });

  it("error when rejected, configured when unreachable, working with plan and units", () => {
    expect(ahrefsRow({ check: { configured: true, works: false, reachable: true, error: "Ahrefs rejected the API key (AHREFS_API_KEY): x.", costUsd: 0 }, chosen: { byDefault: false, clients: 0 }, ...usage }, next).state).toBe("error");
    expect(ahrefsRow({ check: { configured: true, works: null, reachable: false, error: "down", costUsd: 0 }, chosen: { byDefault: false, clients: 0 }, ...usage }, next).state).toBe("configured");
    const ok = ahrefsRow(
      {
        check: { configured: true, works: true, reachable: true, error: null, costUsd: 0, plan: "Standard", resetDate: "2026-11-01", unitsLimitWorkspace: 800_000, unitsUsageWorkspace: 15_000, unitsLimitApiKey: 50_000, unitsUsageApiKey: 1_200, keyExpires: null },
        chosen: { byDefault: true, clients: 0 },
        ...usage,
      },
      next,
    );
    expect(ok).toMatchObject({ state: "working", next: null, data: { default: true, plan: "Standard", unitsUsedThisMonth: 1234, cap: 50_000 } });
    expect(ok.detail).toContain("plan Standard, key 1,200 of 50,000 units used (resets 2026-11-01)");
  });
});

describe("getting-started prompt (Phase 9)", () => {
  it("names the default provider, how to change it (CLI or extension settings), and never asks for a key", () => {
    const text = readFileSync(new URL("../src/prompts/templates/getting-started.md", import.meta.url), "utf8");
    expect(text).toContain("setup --step provider");
    expect(text).toContain("Claude Desktop > Settings > Extensions > Crawlmark");
    expect(text).toContain("`seoDataProvider`");
    expect(text).toMatch(/Never ask me to paste a password, API key \(DataForSEO, Ahrefs, Semrush/);
    expect(text).not.toMatch(/paste (your|the) (Ahrefs|Semrush) key/i);
  });
});

// ------------------------------------------------------------------ provider pick and default (task 5b)

const working = (id: IntegrationId, data?: Record<string, unknown>): IntegrationStatus => ({ id, label: id, state: "working", detail: "", next: null, ...(data ? { data } : {}) });
const seoRow = (data: Record<string, unknown>): IntegrationStatus => ({ id: "seoprovider", label: "Data provider", state: "working", detail: "", next: null, data });

/** A prompt answering by question: multiselect -> `pick`, choose -> `choice` (or the pre-selection), confirm -> false, secret -> `key`. */
function byQuestion(o: { pick?: string[]; choice?: string; key?: string } = {}): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (q, d = {}) => (asked.push(q), d.default ?? ""),
    secret: async (q) => (asked.push(q), o.key ?? ""),
    confirm: async (q) => (asked.push(q), false),
    choose: async <T extends string>(q: string, _c: readonly Choice<T>[], d: T) => (asked.push(q), (o.choice as T) ?? d),
    multiselect: async <T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) => (asked.push(q), (o.pick as T[]) ?? [...d]),
    close() {},
  };
}

describe("provider:pick", () => {
  it("on a fresh home ticks nothing; the user picks (or skips)", async () => {
    let defaults: readonly string[] = [];
    const p = byQuestion();
    p.multiselect = async <T extends string>(_q: string, _c: readonly Choice<T>[], d: readonly T[]) => ((defaults = d), [...d]);
    const h = harness(p);
    await stepProviderPick(h.ctx);
    expect(defaults).toEqual([]);
    expect(h.lines[0]).toBe("SEO data providers: DataForSEO (not set up), Ahrefs (not set up), Semrush (not set up)");
  });

  it("with an Ahrefs key pre-ticks Ahrefs plus any other configured provider", async () => {
    let defaults: readonly string[] = [];
    const p = byQuestion();
    p.multiselect = async <T extends string>(_q: string, _c: readonly Choice<T>[], d: readonly T[]) => ((defaults = d), [...d]);
    const h = harness(p);
    h.states.set("ahrefs", working("ahrefs", { keySet: true }));
    await stepProviderPick(h.ctx);
    expect(defaults).toEqual(["ahrefs"]);
    h.states.set("dataforseo", working("dataforseo"));
    await stepProviderPick(h.ctx);
    expect(defaults).toEqual(["dataforseo", "ahrefs"]);
  });

  it("an empty selection prints the free-tools line; unticking a configured provider keeps its key", async () => {
    const h = harness(byQuestion({ pick: [] }));
    writeFileSync(join(h.home, ".env"), "AHREFS_API_KEY=keep-me\n", { mode: 0o600 });
    h.states.set("ahrefs", working("ahrefs", { keySet: true }));
    const r = await stepProviderPick(h.ctx);
    expect(r.result.message).toBe("No paid provider selected.");
    expect(h.ui.events).toContain("info: No paid provider selected. Free tools (Search Console, GA4, audits) still work. Add one later with setup --step provider.");
    expect(h.ui.events).toContain("info: Ahrefs key kept in .env but not used as the default. Remove AHREFS_API_KEY from .env to forget it.");
    expect(h.env()).toEqual({ AHREFS_API_KEY: "keep-me" });
  });

  it("warns that SERPs, on-page checks and crawls need DataForSEO when only Ahrefs is ticked", async () => {
    const h = harness(byQuestion({ pick: ["ahrefs"] }));
    await stepProviderPick(h.ctx);
    expect(h.ui.events).toContain("warn: Live SERPs, on-page checks and crawls need DataForSEO; without it those parts of run_audit and serp_check are skipped.");
  });
});

describe("provider:default", () => {
  it("0 working providers: nothing written", async () => {
    const h = harness(byQuestion());
    expect(await stepProviderDefault(h.ctx)).toMatchObject({ outcome: "skipped", message: "No working provider yet; paid tools stay unavailable." });
    expect(existsSync(join(h.home, ".env"))).toBe(false);
  });

  it("1 working provider (Ahrefs) and no SEO_DATA_PROVIDER: writes ahrefs with no prompt", async () => {
    const p = byQuestion();
    const h = harness(p);
    h.states.set("ahrefs", working("ahrefs", { keySet: true }));
    h.states.set("seoprovider", seoRow({ default: "dataforseo", source: "default" }));
    const r = await stepProviderDefault(h.ctx);
    expect(r).toMatchObject({ outcome: "done", defaultProvider: "ahrefs", message: "Default: Ahrefs (the only provider set up). Live SERPs, on-page checks and crawls still use DataForSEO (not set up)." });
    expect(p.asked).toEqual([]);
    expect(h.env()).toEqual({ SEO_DATA_PROVIDER: "ahrefs" });
  });

  it("2 working providers: asks with the current default pre-selected and writes only on change", async () => {
    let pre = "";
    const p = byQuestion();
    p.choose = async <T extends string>(q: string, _c: readonly Choice<T>[], d: T) => (p.asked.push(q), (pre = d), d);
    const h = harness(p);
    h.states.set("dataforseo", working("dataforseo"));
    h.states.set("ahrefs", working("ahrefs", { keySet: true }));
    h.states.set("seoprovider", seoRow({ default: "ahrefs", source: "envFile" }));
    expect(await stepProviderDefault(h.ctx)).toMatchObject({ defaultProvider: "ahrefs" });
    expect(pre).toBe("ahrefs");
    expect(p.asked).toEqual(["Default provider for keyword, competitor and backlink data"]);
    expect(h.lines).toContain("Each client can override this (dataProvider in clients.yaml, or clients set <client> --provider).");
    expect(existsSync(join(h.home, ".env"))).toBe(false);

    const change = harness(byQuestion({ choice: "dataforseo" }));
    change.states = h.states;
    change.ctx.status = h.ctx.status;
    await stepProviderDefault(change.ctx);
    expect(change.env()).toEqual({ SEO_DATA_PROVIDER: "dataforseo" });
  });

  it("warns when the shell also sets SEO_DATA_PROVIDER", async () => {
    const h = harness(byQuestion());
    h.ctx.shellEnvKeys = new Set(["SEO_DATA_PROVIDER"]);
    h.states.set("ahrefs", working("ahrefs", { keySet: true }));
    await stepProviderDefault(h.ctx);
    expect(h.ui.events.some((e) => e.startsWith("warn: Warning: your shell (or the MCP client config) also sets SEO_DATA_PROVIDER"))).toBe(true);
  });
});

describe("run plans", () => {
  it("full run selecting Ahrefs only: DataForSEO is 'Not selected.' with no prompt, and Ahrefs runs", async () => {
    const p = byQuestion({ pick: ["ahrefs"], key: SENTINEL });
    const h = harness(p, { respond: ahrefsServer(200), dryRun: true });
    const results = await runWizard(h.ctx);
    expect(results.find((r) => r.step === "dataforseo")).toEqual({ step: "dataforseo", outcome: "skipped", message: "Not selected." });
    expect(results.find((r) => r.step === "ahrefs")).toMatchObject({ outcome: "done" });
    expect(results.find((r) => r.step === "provider")).toMatchObject({ outcome: "done", defaultProvider: "ahrefs" });
    expect(p.asked.filter((q) => /DataForSEO|API login|API password/.test(q))).toEqual([]);
    expect(p.asked).toContain("Ahrefs API key");
    expect(existsSync(join(h.home, ".env"))).toBe(false);
    // The summary marks the default on its provider.
    expect(h.ui.events.find((e) => e.startsWith("summary: "))).toContain("Ahrefs=done");
    expect(transcript(h)).not.toContain(SENTINEL);
  });

  it("--step provider with DataForSEO and Ahrefs already working: only the multi-select and the default select", async () => {
    const p = byQuestion();
    const h = harness(p);
    h.states.set("dataforseo", working("dataforseo"));
    h.states.set("ahrefs", working("ahrefs", { keySet: true }));
    h.states.set("seoprovider", seoRow({ default: "dataforseo", source: "default" }));
    const results = await runWizard(h.ctx, { step: "provider" });
    expect(p.asked).toEqual(["Which SEO data providers do you have?", "Default provider for keyword, competitor and backlink data"]);
    expect(results.map((r) => r.step)).toEqual(["provider"]);
    expect(h.lines.slice(0, 2)).toEqual(["SEO data providers: DataForSEO (working), Ahrefs (working), Semrush (not set up)", "Default provider: DataForSEO (default)."]);
  });

  it("--step ahrefs runs the Ahrefs step, then the default", async () => {
    const h = harness(scripted([true, SENTINEL]), { respond: ahrefsServer(200), dryRun: true });
    const results = await runWizard(h.ctx, { step: "ahrefs" });
    expect(results.map((r) => `${r.step}:${r.outcome}`)).toEqual(["ahrefs:done", "provider:done"]);
    expect(h.ui.events).toContain(`info: Dry run: would set SEO_DATA_PROVIDER in ${join(h.home, ".env")} (mode 0600).`);
  });

  it("--yes on a fresh home: no prompt consumed, Ahrefs 'needs a key', no SEO_DATA_PROVIDER, exit-code outcomes unchanged", async () => {
    const lines: string[] = [];
    const h = harness(autoPrompter((l) => lines.push(l)), { dryRun: true });
    h.ctx.yes = true;
    const results = await runWizard(h.ctx);
    expect(results.find((r) => r.step === "ahrefs")).toEqual({ step: "ahrefs", outcome: "skipped", message: "Ahrefs needs a key; run crawlmark-cli setup --step ahrefs" });
    expect(results.find((r) => r.step === "dataforseo")).toEqual({ step: "dataforseo", outcome: "skipped", message: "DataForSEO needs a login; run crawlmark-cli setup --step dataforseo" });
    expect(results.find((r) => r.step === "provider")).toMatchObject({ outcome: "skipped" });
    expect(results.some((r) => r.outcome === "failed")).toBe(false);
    expect(lines).toContain("Which SEO data providers do you have? none (--yes)");
    expect(transcript(h)).not.toMatch(/SEO_DATA_PROVIDER/);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("--yes with SEO_DATA_PROVIDER=moz in .env and DataForSEO working writes dataforseo", async () => {
    const h = harness(autoPrompter(() => {}));
    h.ctx.yes = true;
    writeFileSync(join(h.home, ".env"), "SEO_DATA_PROVIDER=moz\n", { mode: 0o600 });
    h.states.set("dataforseo", working("dataforseo"));
    h.states.set("seoprovider", { ...seoRow({ default: null, source: "envFile", invalidValue: "moz" }), state: "error" });
    await runWizard(h.ctx, { step: "provider" });
    expect(h.env()).toEqual({ SEO_DATA_PROVIDER: "dataforseo" });
  });

  it("plain transcripts have no ANSI codes; fancy mode shows a spinner per check", async () => {
    const plain = harness(byQuestion({ pick: ["ahrefs"], key: SENTINEL }), { respond: ahrefsServer(200), dryRun: true });
    await runWizard(plain.ctx, { step: "provider" });
    expect(transcript(plain)).not.toMatch(/\u001b\[/);
    const fancy = harness(byQuestion({ pick: ["ahrefs"], key: SENTINEL }), { respond: ahrefsServer(200), dryRun: true, fancy: true });
    await runWizard(fancy.ctx, { step: "provider" });
    expect(fancy.ui.events).toContain("spin: Checking with Ahrefs (free limits-and-usage call)...");
    expect(fancy.ui.events.filter((e) => e === "spin: Checking the current status...").length).toBeGreaterThanOrEqual(2);
  });
});

// ------------------------------------------------------------------ the seoprovider row

describe("the seoprovider row", () => {
  const states = (o: Partial<Record<"dataforseo" | "ahrefs" | "semrush", IntegrationStatus["state"]>>) => ({ dataforseo: "missing" as const, ahrefs: "missing" as const, semrush: "missing" as const, ...o });
  const opts = { cli: "crawlmark-cli", configuredByEnv: false };

  it("working, configured and error states", () => {
    const ok = seoProviderRow({ default: "ahrefs", source: "envFile", perClientOverrides: 0 }, states({ ahrefs: "working", dataforseo: "working" }), opts);
    expect(ok).toMatchObject({ state: "working", detail: "Ahrefs (default, from .env). DataForSEO for live SERPs, on-page and crawls.", next: null });
    expect(ok.data).toEqual({ default: "ahrefs", source: "envFile", configured: { dataforseo: true, ahrefs: true, semrush: false }, perClientOverrides: 0, change: "crawlmark-cli setup --step provider" });
    expect(seoProviderRow({ default: "ahrefs", source: "envFile", perClientOverrides: 0 }, states({ ahrefs: "configured" }), opts).state).toBe("configured");
    expect(seoProviderRow({ default: "ahrefs", source: "envFile", perClientOverrides: 1 }, states({}), opts)).toMatchObject({ state: "error", next: "crawlmark-cli setup --step provider" });
    const bad = seoProviderRow({ default: null, source: "env", invalidValue: "moz", perClientOverrides: 0 }, states({ dataforseo: "working" }), opts);
    expect(bad).toMatchObject({ state: "error", next: "crawlmark-cli setup --step provider", data: { default: null, invalidValue: "moz" } });
    expect(bad.detail).toMatch(/dataforseo, ahrefs or semrush, or leave it blank for dataforseo/);
  });

  it("a bundle-sourced default points at the extension settings", () => {
    const r = seoProviderRow({ default: "ahrefs", source: "env", perClientOverrides: 0 }, states({}), { cli: "x", configuredByEnv: true });
    expect(r.next).toBe('Change "Default SEO data provider" in Claude Desktop > Settings > Extensions > Crawlmark');
    expect(r.data?.change).toBe("x setup --step provider");
  });

  it("the report carries seoDataProvider, and a key never appears in the JSON or rendered text", async () => {
    const leaky = (async () => new Response(JSON.stringify({ error: `bad key ${SENTINEL}` }), { status: 401 })) as unknown as typeof fetch;
    const p: StatusProviders = {
      home: () => ({ info: { dir: "/h", source: "env", reason: "test" }, exists: true, envFile: "/h/.env", envFileExists: true, configuredByEnv: false }),
      cli: () => "crawlmark-cli",
      dataforseo: async () => ({ credentialsConfigured: false, credentialsWork: false, reachable: true, mode: "sandbox", apiHost: "x", error: "not set", costUsd: 0 }),
      ahrefs: async () => ({ check: await checkAhrefsKey(SENTINEL, leaky), chosen: { byDefault: true, clients: 0 }, unitsUsedThisMonth: 0, cap: 50_000 }),
      seoDataProvider: () => ({ default: "ahrefs", source: "envFile", perClientOverrides: 0 }),
      semrush: async () => ({ keySet: false, chosen: { byDefault: false, clients: 0 }, unitsUsedThisMonth: 0, cap: 20_000 }),
      googleStatus: () => ({ mode: "none", auto: true, configured: false, problem: "none" }),
      googleLive: vi.fn(),
      gscSites: vi.fn(),
      ga4Properties: vi.fn(),
      gtmContainers: vi.fn(),
      psiKeySet: () => false,
      chrome: async () => ({ ok: true, version: "x" }),
      clients: () => ({ count: 0, ignored: 0, file: "/h/c.yaml", exists: false }),
    };
    const r = await collectSetupStatus(p, { only: ["seoprovider", "ahrefs"] });
    expect(r.integrations.map((i) => `${i.id}:${i.state}`)).toEqual(["seoprovider:error", "ahrefs:error"]);
    expect(r.seoDataProvider).toMatchObject({ default: "ahrefs", source: "envFile" });
    const rendered = renderStatus({ ...r, fromCache: false }, { width: 80, color: false, unicode: true }).join("\n");
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    expect(rendered).not.toContain(SENTINEL);
    expect(rendered).toContain("<redacted>");
  });
});

describe("summary box (Phase 9)", () => {
  it("marks the default provider, has no cell for the provider step, and ends with 'Change providers'", () => {
    const s = summarize({ cliDisplay: "npx crawlmark-mcp", dryRun: false }, [
      { step: "node", outcome: "done", message: "" },
      { step: "dataforseo", outcome: "done", message: "" },
      { step: "ahrefs", outcome: "done", message: "" },
      { step: "provider", outcome: "done", message: "", defaultProvider: "ahrefs" },
    ]);
    expect(s.rows.map((r) => `${r.label}:${r.outcome}${r.note ? ` ${r.note}` : ""}`)).toEqual(["Node:done", "DataForSEO:done", "Ahrefs:done (default)"]);
    expect(s.next.at(-1)).toBe("Change providers: npx crawlmark-mcp setup --step provider");
  });
});

// ------------------------------------------------------------------ Semrush setup and status (task 7)

const semrushServer = (body: string, status = 200) => (url: URL) =>
  url.pathname.endsWith("/countapiunits.html") ? new Response(body, { status }) : new Response("not found", { status: 404 });

describe("stepSemrush", () => {
  const SAVED_NOTE = "Saved. Semrush has no free key check, so the key is checked on the first paid call (keyword volume or backlinks).";

  it("asks once for a v4 key, saves SEMRUSH_API_KEY with no request, and says there is no free check", async () => {
    const p = scripted([true, SENTINEL]);
    const h = harness(p, { respond: semrushServer("unused") });
    const r = await stepSemrush(h.ctx);
    expect(r).toMatchObject({ step: "semrush", outcome: "done", message: expect.stringContaining("no free key check") });
    expect(p.asked).toEqual(["Set up Semrush now?", "Semrush API key (v4, from your profile > API keys)"]);
    expect(h.ui.events).toContain(`info: ${SAVED_NOTE}`);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.env()).toEqual({ SEMRUSH_API_KEY: SENTINEL });
    expect(transcript(h)).not.toContain(SENTINEL);
  });

  it("says v3 keys aren't supported and where to create a v4 key", async () => {
    const h = harness(scripted([true, SENTINEL]), { respond: semrushServer("unused") });
    await stepSemrush(h.ctx);
    const out = transcript(h);
    expect(out).toContain("Create a v4 API key under your profile > API keys. Semrush's older v3 keys aren't supported; create a v4 key.");
    expect(out).toContain("50,000 come with SEO Classic Pro and Guru");
  });

  it("strips quotes and spaces from a pasted key", async () => {
    const h = harness(scripted([true, `  "${SENTINEL}"  `]), { respond: semrushServer("unused") });
    await stepSemrush(h.ctx);
    expect(h.env()).toEqual({ SEMRUSH_API_KEY: SENTINEL });
  });

  it("0.1.0 with both keys: Enter keeps the v4 key (SEMRUSH_V4_API_KEY, which wins), saves it as SEMRUSH_API_KEY and removes the alias; the old v3 key is dropped", async () => {
    const p = scripted([true, ""]);
    const h = harness(p, { respond: semrushServer("unused") });
    writeFileSync(join(h.home, ".env"), `DATAFORSEO_LOGIN=me\nSEMRUSH_API_KEY=old-v3-${SENTINEL}\nSEMRUSH_V4_API_KEY=v4-${SENTINEL}\n`, { mode: 0o600 });
    const r = await stepSemrush(h.ctx);
    expect(r.outcome).toBe("done");
    expect(p.asked[1]).toContain("Enter keeps the current one");
    expect(h.env()).toEqual({ DATAFORSEO_LOGIN: "me", SEMRUSH_API_KEY: `v4-${SENTINEL}` });
    expect(readFileSync(join(h.home, ".env"), "utf8")).not.toContain("SEMRUSH_V4_API_KEY");
    if (POSIX_MODES) expect(statSync(join(h.home, ".env")).mode & 0o777).toBe(0o600);
    expect(transcript(h)).not.toContain(SENTINEL);
  });

  it("an empty answer is asked again, at most 3 times, and saves nothing", async () => {
    const h = harness(scripted([true, "", "", ""]), { respond: semrushServer("unused") });
    expect(await stepSemrush(h.ctx)).toMatchObject({ outcome: "failed" });
    expect(h.ui.events.filter((e) => e === "fail: No key entered.")).toHaveLength(3);
    expect(existsSync(join(h.home, ".env"))).toBe(false);
  });

  it("--yes skips the key (needs a key)", async () => {
    const h = harness(autoPrompter(() => {}));
    h.ctx.yes = true;
    expect(await stepSemrush(h.ctx)).toEqual({ step: "semrush", outcome: "skipped", message: "Semrush needs a key; run crawlmark-cli setup --step semrush" });
  });

  it("--step semrush runs the Semrush step, then the default", async () => {
    const h = harness(scripted([true, SENTINEL, false]), { respond: semrushServer("5,000"), dryRun: true });
    const results = await runWizard(h.ctx, { step: "semrush" });
    expect(results.map((r) => `${r.step}:${r.outcome}`)).toEqual(["semrush:done", "provider:done"]);
    expect(results[1]).toMatchObject({ defaultProvider: "semrush" });
  });
});

describe("the semrush status row", () => {
  it("missing, error when chosen without a key, configured with a key (no free check)", () => {
    const base = { chosen: { byDefault: false, clients: 0 }, unitsUsedThisMonth: 0, cap: 20_000 };
    const next = "crawlmark-cli setup --step semrush";
    expect(semrushRow({ ...base, keySet: false }, next).state).toBe("missing");
    expect(semrushRow({ ...base, keySet: false, chosen: { byDefault: false, clients: 1 } }, next).state).toBe("error");
    expect(semrushRow({ ...base, keySet: true }, next)).toMatchObject({ state: "configured", next: null, data: { keySet: true, keyCheck: "none", cap: 20_000 } });
  });
});

describe("setup status --only seoprovider,ahrefs,semrush --json (CLI)", () => {
  it("returns those three rows and no key", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-statuscli-")));
    const r = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), "setup", "status", "--only", "seoprovider,ahrefs,semrush", "--json"],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, CRAWLMARK_HOME: home, AHREFS_API_KEY: SENTINEL, SEMRUSH_API_KEY: SENTINEL, SEO_DATA_PROVIDER: "ahrefs" } },
    );
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as SetupStatusReport;
    expect(report.integrations.map((i) => i.id)).toEqual(["seoprovider", "ahrefs", "semrush"]);
    // The keys are set; Ahrefs' API (pointed at a closed local port) can't be reached and Semrush has no free check: untested.
    expect(report.integrations.map((i) => i.state)).toEqual(["configured", "configured", "configured"]);
    expect(report.seoDataProvider).toMatchObject({ default: "ahrefs", source: "env", configured: { ahrefs: true, semrush: true } });
    expect(r.stdout).not.toContain(SENTINEL);
    expect(r.stderr).not.toContain(SENTINEL);
  }, 60_000);
});

describe("MCPB manifest (Phase 9)", () => {
  const manifest = JSON.parse(readFileSync(new URL("../mcpb/manifest.json", import.meta.url), "utf8"));
  const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const uc = manifest.user_config;
  const envMap = manifest.server.mcp_config.env as Record<string, string>;

  it("has the six new fields, each mapped to an env var config reads", () => {
    const fields = { seo_data_provider: "SEO_DATA_PROVIDER", ahrefs_api_key: "AHREFS_API_KEY", semrush_api_key: "SEMRUSH_API_KEY", ahrefs_monthly_unit_cap: "AHREFS_MONTHLY_UNIT_CAP", semrush_monthly_unit_cap: "SEMRUSH_MONTHLY_UNIT_CAP" };
    for (const [field, envVar] of Object.entries(fields)) {
      expect(uc[field], field).toBeDefined();
      expect(uc[field].required, field).toBe(false);
      expect(envMap[envVar], field).toBe(`\${user_config.${field}}`);
      expect(config, envVar).toContain(envVar);
    }
  });

  it("seo_data_provider has no default and names all three values; keys are sensitive; caps are numbers with min 1", () => {
    expect(uc.seo_data_provider.default).toBeUndefined();
    for (const v of ["dataforseo", "ahrefs", "semrush"]) expect(uc.seo_data_provider.description).toContain(v);
    for (const k of ["ahrefs_api_key", "semrush_api_key"]) expect(uc[k].sensitive, k).toBe(true);
    for (const k of ["ahrefs_monthly_unit_cap", "semrush_monthly_unit_cap"]) expect(uc[k]).toMatchObject({ type: "number", min: 1 });
    // The Semrush key is v4. The 0.1.0 v4 field stays mapped so a bundle user's existing v4 key still wins over their old v3 field.
    expect(uc.semrush_api_key.title).toBe("Semrush API key (v4)");
    expect(uc.semrush_v4_api_key).toMatchObject({ type: "string", sensitive: true, required: false });
    expect(envMap.SEMRUSH_V4_API_KEY).toBe("${user_config.semrush_v4_api_key}");
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["ahrefs_status", "semrush_status"]));
  });
});

describe("DataForSEO in the provider flow", () => {
  it("a passing DataForSEO check counts as working for the default select, even in a dry run", async () => {
    const dfs = () =>
      new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ money: { balance: 1, total: 5 } }] }] }), { status: 200 });
    const h = harness(scripted(["sandbox", "login@example.com", "pw"]), { respond: dfs, dryRun: true });
    writeFileSync(join(h.home, ".env"), "DATAFORSEO_BASE_URL=http://127.0.0.1:9/sandbox/v3\n", { mode: 0o600 });
    expect(await stepDataForSeo(h.ctx, { ticked: true })).toMatchObject({ outcome: "done" });
    expect(h.ctx.providers?.working.has("dataforseo")).toBe(true);
  });
});

describe("R-1: a check that fails this run never moves the default to another provider", () => {
  const configured = (id: IntegrationId, data: Record<string, unknown>): IntegrationStatus => ({ id, label: id, state: "configured", detail: "", next: null, data });

  it("--yes keeps a default Ahrefs whose key is set but unreachable, even with DataForSEO working, and says 'untested'", async () => {
    const h = harness(autoPrompter(() => {}));
    h.ctx.yes = true;
    writeFileSync(join(h.home, ".env"), "SEO_DATA_PROVIDER=ahrefs\nAHREFS_API_KEY=keep\n", { mode: 0o600 });
    h.states.set("dataforseo", working("dataforseo"));
    h.states.set("ahrefs", configured("ahrefs", { keySet: true }));
    h.states.set("seoprovider", seoRow({ default: "ahrefs", source: "envFile" }));
    const results = await runWizard(h.ctx, { step: "provider" });
    expect(results.find((r) => r.step === "ahrefs")).toEqual({ step: "ahrefs", outcome: "skipped", message: "Ahrefs key is set but untested; run crawlmark-cli setup --step ahrefs" });
    expect(results.find((r) => r.step === "provider")).toMatchObject({ defaultProvider: "ahrefs", message: expect.stringContaining("Default: Ahrefs (kept).") });
    expect(h.env()).toEqual({ SEO_DATA_PROVIDER: "ahrefs", AHREFS_API_KEY: "keep" });
  });

  it("--yes keeps a working default rather than switching to the first working provider", async () => {
    const h = harness(autoPrompter(() => {}));
    h.ctx.yes = true;
    h.states.set("dataforseo", working("dataforseo"));
    h.states.set("ahrefs", working("ahrefs", { keySet: true }));
    h.states.set("seoprovider", seoRow({ default: "ahrefs", source: "envFile" }));
    expect(await stepProviderDefault(h.ctx)).toMatchObject({ defaultProvider: "ahrefs" });
    expect(existsSync(join(h.home, ".env"))).toBe(false);
  });

  it("interactive (setup --step dataforseo): an unreachable default Ahrefs is kept with no prompt", async () => {
    const p = byQuestion({ choice: "dataforseo" });
    const h = harness(p);
    h.ctx.providers = { working: new Set(["dataforseo"]) };
    h.states.set("ahrefs", configured("ahrefs", { keySet: true }));
    h.states.set("seoprovider", seoRow({ default: "ahrefs", source: "envFile" }));
    expect(await stepProviderDefault(h.ctx)).toMatchObject({ defaultProvider: "ahrefs", message: expect.stringContaining("wasn't confirmed working in this run") });
    expect(p.asked).toEqual([]);
    expect(existsSync(join(h.home, ".env"))).toBe(false);
  });

  it("a Semrush default at a 0 balance (configured) is kept", async () => {
    const h = harness(byQuestion());
    h.states.set("dataforseo", working("dataforseo"));
    h.states.set("semrush", configured("semrush", { keySet: true, unitsLeft: 0 }));
    h.states.set("seoprovider", seoRow({ default: "semrush", source: "envFile" }));
    expect(await stepProviderDefault(h.ctx)).toMatchObject({ defaultProvider: "semrush" });
    expect(existsSync(join(h.home, ".env"))).toBe(false);
  });

  it("a rejected (error) or unticked default is replaced", async () => {
    const rejected = harness(autoPrompter(() => {}));
    rejected.ctx.yes = true;
    rejected.states.set("dataforseo", working("dataforseo"));
    rejected.states.set("ahrefs", { ...configured("ahrefs", { keySet: true }), state: "error" });
    rejected.states.set("seoprovider", seoRow({ default: "ahrefs", source: "envFile" }));
    expect(await stepProviderDefault(rejected.ctx)).toMatchObject({ defaultProvider: "dataforseo" });
    expect(rejected.env()).toEqual({ SEO_DATA_PROVIDER: "dataforseo" });

    const unticked = harness(byQuestion());
    unticked.ctx.providers = { selected: new Set(["dataforseo"]), working: new Set() };
    unticked.states.set("dataforseo", working("dataforseo"));
    unticked.states.set("ahrefs", working("ahrefs", { keySet: true }));
    unticked.states.set("seoprovider", seoRow({ default: "ahrefs", source: "envFile" }));
    expect(await stepProviderDefault(unticked.ctx)).toMatchObject({ defaultProvider: "dataforseo" });
    expect(unticked.env()).toEqual({ SEO_DATA_PROVIDER: "dataforseo" });
  });
});

describe("R-2: the seoprovider row on a fresh or free-only install", () => {
  const none = { dataforseo: "missing" as const, ahrefs: "missing" as const, semrush: "missing" as const };
  const opts = { cli: "crawlmark-cli", configuredByEnv: false };
  it("is missing (with the next step) when nothing is chosen and DataForSEO has no login", () => {
    expect(seoProviderRow({ default: "dataforseo", source: "default", perClientOverrides: 0 }, none, opts)).toMatchObject({ state: "missing", next: "crawlmark-cli setup --step provider" });
  });
  it("stays error for an explicit choice with no key, or an invalid value", () => {
    expect(seoProviderRow({ default: "dataforseo", source: "envFile", perClientOverrides: 0 }, none, opts).state).toBe("error");
    expect(seoProviderRow({ default: "ahrefs", source: "env", perClientOverrides: 0 }, none, opts).state).toBe("error");
    expect(seoProviderRow({ default: null, source: "env", invalidValue: "moz", perClientOverrides: 0 }, none, opts).state).toBe("error");
    expect(seoProviderRow({ default: "dataforseo", source: "default", perClientOverrides: 0 }, { ...none, dataforseo: "error" }, opts).state).toBe("error");
  });
});
