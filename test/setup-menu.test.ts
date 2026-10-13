import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compactStatusLine, isSetupComplete, MENU_CHOICES, MENU_QUESTION, MENU_STATUS_IDS, menuStep, returningUserMenu } from "../src/setup/menu.js";
import type { IntegrationId, IntegrationStatus, SetupStatusReport } from "../src/setup/status.js";
import { recordingUi } from "../src/setup/ui.js";
import type { WizardContext } from "../src/setup/wizard.js";

function report(rows: Partial<Record<IntegrationId, [IntegrationStatus["state"], Record<string, unknown>?]>>): SetupStatusReport {
  return {
    home: { dir: "/h", source: "user", reason: "", envFile: "/h/.env", envFileExists: true },
    cli: "npx crawlmark-mcp",
    integrations: Object.entries(rows).map(([id, [state, data]]) => ({ id: id as IntegrationId, label: id, state, detail: "", next: null, ...(data ? { data } : {}) })),
    summary: { working: 0, configured: 0, missing: 0, error: 0 },
    checkedAt: "",
    fromCache: false,
    costUsd: 0,
  } as SetupStatusReport;
}

function ctxFor(opts: { fancy?: boolean; status?: () => Promise<SetupStatusReport>; answer?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-menu-")));
  const ui = recordingUi({ fancy: opts.fancy ?? true });
  const choose = vi.fn(async () => opts.answer ?? "provider");
  const status = vi.fn(opts.status ?? (async () => report({ dataforseo: ["working"], google: ["missing"], ahrefs: ["missing"], semrush: ["missing"], clients: ["working", { count: 11 }] })));
  const ctx = {
    prompt: { ask: vi.fn(), secret: vi.fn(), confirm: vi.fn(), choose, close() {} },
    out: () => {},
    status,
    paths: { envFile: join(base, ".env"), home: base },
    ui,
    cliDisplay: "npx crawlmark-mcp",
    dryRun: true,
  } as unknown as WizardContext;
  return { ctx, ui, choose, status };
}

describe("returning-user menu", () => {
  it("lists the seven choices, mapping four to --step", () => {
    expect(MENU_CHOICES.map((c) => c.label)).toEqual([
      "Add or change a data provider",
      "Change Google sign-in",
      "Re-register AI apps",
      "Refresh clients",
      "Check status",
      "Run full setup again",
      "Exit",
    ]);
    expect(MENU_CHOICES.map((c) => menuStep(c.value))).toEqual(["provider", "google", "register", "discovery", undefined, undefined, undefined]);
  });

  it("is complete with a .env and at least one working data source", () => {
    expect(isSetupComplete(true, report({ google: ["working"] }))).toBe(true);
    expect(isSetupComplete(true, report({ ahrefs: ["working"] }))).toBe(true);
    // Semrush with units left counts even while its v4 key is untested.
    expect(isSetupComplete(true, report({ semrush: ["configured", { unitsLeft: 10 }] }))).toBe(true);
    expect(isSetupComplete(true, report({ semrush: ["configured", { unitsLeft: 0 }] }))).toBe(false);
    expect(isSetupComplete(true, report({ dataforseo: ["configured"], google: ["error"], clients: ["working"] }))).toBe(false);
    expect(isSetupComplete(false, report({ google: ["working"] }))).toBe(false);
  });

  it("the compact line shows icons per state and only the client count", () => {
    expect(compactStatusLine(report({ dataforseo: ["working"], google: ["error"], ahrefs: ["missing"], semrush: ["configured", { unitsLeft: 5 }], clients: ["working", { count: 11 }] }))).toBe(
      "✔ DataForSEO   ✖ Google   ○ Ahrefs   ✔ Semrush   ✔ Clients 11",
    );
  });

  it("shows the status line and asks, returning the choice", async () => {
    const { ctx, ui, choose, status } = ctxFor({ answer: "discovery" });
    expect(await returningUserMenu(ctx, { envFileExists: () => true })).toBe("discovery");
    expect(status).toHaveBeenCalledWith(MENU_STATUS_IDS);
    expect(ui.events).toContain("spin: Checking your setup...");
    expect(ui.events).toContain("line: ✔ DataForSEO   ○ Google   ○ Ahrefs   ○ Semrush   ✔ Clients 11");
    expect(choose).toHaveBeenCalledWith(MENU_QUESTION, MENU_CHOICES, "provider");
  });

  it("no menu without a .env, with nothing working, when the status can't be read, or in plain mode", async () => {
    const noEnv = ctxFor();
    expect(await returningUserMenu(noEnv.ctx, { envFileExists: () => false })).toBeUndefined();
    expect(noEnv.status).not.toHaveBeenCalled();
    const nothing = ctxFor({ status: async () => report({ dataforseo: ["missing"], google: ["missing"], clients: ["working", { count: 0 }] }) });
    expect(await returningUserMenu(nothing.ctx, { envFileExists: () => true })).toBeUndefined();
    const broken = ctxFor({
      status: async () => {
        throw new Error("child failed");
      },
    });
    expect(await returningUserMenu(broken.ctx, { envFileExists: () => true })).toBeUndefined();
    const plain = ctxFor({ fancy: false });
    expect(await returningUserMenu(plain.ctx, { envFileExists: () => true })).toBeUndefined();
    for (const c of [noEnv, nothing, broken, plain]) expect(c.choose).not.toHaveBeenCalled();
  });

  it("checks the real .env path by default", async () => {
    const { ctx, choose } = ctxFor();
    // The temp home has no .env.
    expect(await returningUserMenu(ctx)).toBeUndefined();
    expect(choose).not.toHaveBeenCalled();
  });
});
