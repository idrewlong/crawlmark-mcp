/**
 * Phase 10: the returning-user menu. When `init` / `setup` (no --step) runs in
 * fancy mode on a home that is already set up, the user picks what to do instead
 * of walking through every step again. Plain mode, --yes and --step never get here
 * (src/setup/cli-setup.ts decides), so their behaviour is unchanged.
 */
import { existsSync } from "node:fs";
import type { Choice } from "./prompter.js";
import type { IntegrationId, IntegrationStatus, SetupStatusReport } from "./status.js";
import { uiFor } from "./ui.js";
import { works, type StepName, type WizardContext } from "./wizard.js";

export type MenuAction = "provider" | "google" | "register" | "discovery" | "status" | "full" | "exit";

export const MENU_QUESTION = "crawlmark is already set up. What would you like to do?";

export const MENU_CHOICES: readonly Choice<MenuAction>[] = [
  { value: "provider", label: "Add or change a data provider" },
  { value: "google", label: "Change Google sign-in" },
  { value: "register", label: "Re-register AI apps" },
  { value: "discovery", label: "Refresh clients" },
  { value: "status", label: "Check status" },
  { value: "full", label: "Run full setup again" },
  { value: "exit", label: "Exit" },
];

/** The --step a menu action runs, if it is one. */
export function menuStep(action: MenuAction): StepName | undefined {
  return action === "provider" || action === "google" || action === "register" || action === "discovery" ? action : undefined;
}

/** What the menu's status read asks for. */
export const MENU_STATUS_IDS: IntegrationId[] = ["dataforseo", "ahrefs", "semrush", "google", "clients"];

const CREDENTIAL_ROWS = ["dataforseo", "ahrefs", "semrush", "google"] as const;

function rowWorks(id: (typeof CREDENTIAL_ROWS)[number], row: IntegrationStatus | undefined): boolean {
  return id === "google" ? row?.state === "working" : works(id, row);
}

/** Set up enough for the menu (pure): the home has a .env and at least one data source works. */
export function isSetupComplete(envFileExists: boolean, report: SetupStatusReport): boolean {
  if (!envFileExists) return false;
  const rows = new Map(report.integrations.map((i) => [i.id, i]));
  return CREDENTIAL_ROWS.some((id) => rowWorks(id, rows.get(id)));
}

const LABELS: Record<(typeof CREDENTIAL_ROWS)[number], string> = { dataforseo: "DataForSEO", google: "Google", ahrefs: "Ahrefs", semrush: "Semrush" };
const ICON: Record<IntegrationStatus["state"], string> = { working: "✔", configured: "●", error: "✖", missing: "○" };

/** One line above the menu (pure): `✔ DataForSEO   ✔ Google   ○ Ahrefs   ○ Semrush   ✔ Clients 11`. Only counts, never client names. */
export function compactStatusLine(report: SetupStatusReport): string {
  const rows = new Map(report.integrations.map((i) => [i.id, i]));
  const cells: string[] = [];
  for (const id of ["dataforseo", "google", "ahrefs", "semrush"] as const) {
    const row = rows.get(id);
    if (!row) continue;
    cells.push(`${rowWorks(id, row) ? "✔" : ICON[row.state]} ${LABELS[id]}`);
  }
  const clients = rows.get("clients");
  if (clients) {
    const count = typeof clients.data?.count === "number" ? ` ${clients.data.count}` : "";
    cells.push(`${ICON[clients.state]} Clients${count}`);
  }
  return cells.join("   ");
}

/**
 * Show the menu when the home is set up (fancy mode only; the caller has shown the intro).
 * Returns undefined when it isn't (no .env, nothing works, or the status can't be read):
 * the full wizard runs, as before.
 */
export async function returningUserMenu(ctx: WizardContext, opts: { envFileExists?: (path: string) => boolean } = {}): Promise<MenuAction | undefined> {
  const ui = uiFor(ctx);
  if (!ui.fancy) return undefined;
  if (!(opts.envFileExists ?? existsSync)(ctx.paths.envFile)) return undefined;
  let report: SetupStatusReport;
  try {
    report = await ui.spin("Checking your setup...", () => ctx.status(MENU_STATUS_IDS), { plain: false });
  } catch {
    return undefined;
  }
  if (!isSetupComplete(true, report)) return undefined;
  ui.line(compactStatusLine(report));
  return ctx.prompt.choose(MENU_QUESTION, MENU_CHOICES, "provider");
}
