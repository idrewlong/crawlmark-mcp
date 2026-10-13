/**
 * `crawlmark-cli setup`: an interactive, re-runnable walk through every
 * integration. Each step shows the current status first and can be skipped.
 * All I/O is injected through WizardContext (prompt, output, child processes,
 * fetch, status, key-file check, paths), so every step runs in tests with fake
 * I/O and temp directories. Files are only written under the config home and,
 * after showing the diff and asking, Claude Desktop's config.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { APP_LABELS, registerApps, type AppOutcome } from "./apps.js";
import { copyFileAtomic } from "../lib/atomic-file.js";
import { readEnvFile, writeEnvFile } from "../lib/env-file.js";
import { expandPath, sourceCheckoutMarker, type HomeSource } from "../lib/home.js";
import { checkAhrefsKey } from "../providers/ahrefs.js";
import { describeAhrefsAccount } from "../providers/ahrefs-shape.js";
import { checkDataForSeoCredentials } from "../providers/dataforseo.js";
import { checkSemrushKey } from "../providers/semrush.js";
import { displayProviderValue, PROVIDER_LABELS, quoteProviderValue, type ProviderId } from "../lib/provider-ids.js";
import { checkPsiKey } from "./checks.js";
import { checkCruxKey } from "../providers/crux.js";
import { NeedsInputError, PromptAbortedError, type Prompter } from "./prompter.js";
import { uiFor, type SummaryRow, type Ui } from "./ui.js";
import { tryAskingExamples, type ExampleClient } from "./try-asking.js";
import { DFS_LIVE_URL, DFS_SANDBOX_URL } from "../lib/env.js";
import { LINKS, type IntegrationId, type IntegrationStatus, type SetupStatusReport } from "./status.js";

export const STEP_NAMES = ["node", "provider", "dataforseo", "ahrefs", "semrush", "google", "psi", "discovery", "register"] as const;
/**
 * Phase 12: steps run only with --step. They are not in the default flow, the returning-user menu or the
 * step lists the wizard prints, so plain installer output is unchanged.
 */
export const EXTRA_STEP_NAMES = ["crux"] as const;
export type StepName = (typeof STEP_NAMES)[number] | (typeof EXTRA_STEP_NAMES)[number];

export { DFS_LIVE_URL, DFS_SANDBOX_URL };
export const MIN_NODE = [22, 13] as const;
/** Where option C copies the key, relative to the home. */
export const KEY_FILE_REL = join("secrets", "google-service-account.json");

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WizardContext {
  prompt: Prompter;
  out(line?: string): void;
  /**
   * Run a program (no shell). `inherit` gives it the terminal (for `auth login`,
   * builds and discovery output); otherwise output is captured. A missing
   * program resolves with code 127.
   */
  exec(cmd: string, args: string[], opts?: { inherit?: boolean; cwd?: string }): Promise<ExecResult>;
  /** Run crawlmark-cli itself in a fresh process (so it reads the .env this wizard just wrote). */
  cli(args: string[], opts?: { inherit?: boolean }): Promise<ExecResult>;
  fetch: typeof fetch;
  /** setup_status for some integrations, read fresh (a child process in the real CLI). */
  status(only: IntegrationId[], opts?: { refresh?: boolean }): Promise<SetupStatusReport>;
  /** Shape check plus a live token request for a service-account key file. */
  checkKeyFile(path: string): Promise<{ ok: true; email: string } | { ok: false; problem: string }>;
  paths: {
    home: string;
    homeSource: HomeSource;
    projectRoot: string;
    envFile: string;
    userHome: string;
    cwd: string;
    /** Claude Desktop's config for this OS, if it has one. */
    desktopConfig: string | undefined;
    /** Cursor's global mcp.json. Cursor is offered only when this is set. */
    cursorConfig?: string | undefined;
    /** Codex's config.toml. Codex is offered only when this is set. */
    codexConfig?: string | undefined;
  };
  /** True when a program is on PATH (Cursor detection). */
  which?(name: string): boolean;
  /** How progress is shown. Unset means plain text through `out` (today's output). */
  ui?: Ui | undefined;
  /** `setup` or `init`, for the intro. */
  command?: "setup" | "init";
  /** crawlmark's version, for the fancy intro. */
  version?: string;
  node: { version: string; execPath: string };
  /** How the user runs the CLI here, for printed instructions. */
  cliDisplay: string;
  /** Variables set by the shell (not .env): they override .env, so the wizard warns when it writes one. */
  shellEnvKeys: ReadonlySet<string>;
  dryRun: boolean;
  /** --yes: no input is read (autoPrompter). Credential steps that need a key end as skipped. */
  yes?: boolean | undefined;
  /**
   * SEO data providers for this run (Phase 9): `selected` from the provider pick (unset when the
   * run has no pick), `working` grows as credential checks pass.
   */
  providers?: { selected?: ReadonlySet<ProviderId> | undefined; working: Set<ProviderId> } | undefined;
  /**
   * Phase 10: open a URL in the browser. The real CLI sets it in fancy mode only; unset means the
   * wizard never offers "Press Enter to open" (plain mode, tests).
   */
  openUrl?: ((url: string) => boolean) | undefined;
  /**
   * Phase 10: the user's clients for the "Try asking Claude" examples, read from the local
   * clients.yaml. The real CLI sets it in fancy mode only; unset means example.com.
   */
  exampleClients?: (() => ExampleClient[]) | undefined;
}

/** Options for a provider credential step. `ticked`: the user just picked it in the provider list, so don't ask again whether to set it up. */
export interface CredentialStepOptions {
  ticked?: boolean;
}

/** Record that a provider's check passed in this run (the default select offers it even in a dry run). */
function markWorking(ctx: WizardContext, id: ProviderId): void {
  ctx.providers ??= { working: new Set() };
  ctx.providers.working.add(id);
}

export type StepOutcome = "done" | "skipped" | "failed" | "needs-input";

export interface StepResult {
  step: StepName;
  outcome: StepOutcome;
  message: string;
  /** The register step: what happened with each app. */
  apps?: AppOutcome[];
  /** The provider step: the default it settled on (marked "(default)" in the summary). */
  defaultProvider?: ProviderId;
}

const MAX_ATTEMPTS = 3;
const stateTag = (s: IntegrationStatus["state"]) => ({ working: "OK", configured: "SET", missing: "MISSING", error: "ERROR" })[s];

// ------------------------------------------------------------------ helpers

async function showStatus(ctx: WizardContext, only: IntegrationId[], opts: { refresh?: boolean } = {}): Promise<Map<IntegrationId, IntegrationStatus>> {
  const map = new Map<IntegrationId, IntegrationStatus>();
  try {
    const report = await uiFor(ctx).spin("Checking the current status...", () => ctx.status(only, opts), { plain: false });
    for (const i of report.integrations) {
      map.set(i.id, i);
      ctx.out(`  [${stateTag(i.state)}] ${i.label}: ${i.detail}`);
      if (i.next && i.state !== "working") ctx.out(`         next: ${i.next}`);
    }
  } catch (err) {
    ctx.out(`  (Couldn't read the current status: ${(err as Error).message})`);
  }
  return map;
}

/** Write keys to <home>/.env (0600), or say what would be written in a dry run. Values are never printed. */
function saveEnv(ctx: WizardContext, updates: Record<string, string>): void {
  const keys = Object.keys(updates).join(", ");
  const ui = uiFor(ctx);
  if (ctx.dryRun) {
    ui.info(`Dry run: would set ${keys} in ${ctx.paths.envFile} (mode 0600).`);
    return;
  }
  const r = writeEnvFile(ctx.paths.envFile, updates);
  const changed = [...r.updated, ...r.added];
  ui.success(changed.length ? `Saved ${changed.join(", ")} to ${ctx.paths.envFile} (mode 0600).` : `${ctx.paths.envFile} already had these values.`);
  const shadowed = Object.keys(updates).filter((k) => ctx.shellEnvKeys.has(k));
  if (shadowed.length) {
    ui.warn(`Warning: your shell (or the MCP client config) also sets ${shadowed.join(", ")}, which overrides .env. Unset it there for the new value to take effect.`);
  }
}

function existingEnv(ctx: WizardContext): Record<string, string> {
  return readEnvFile(ctx.paths.envFile);
}

/**
 * Phase 10: "Press Enter to open <page> in your browser (or s to skip)". Only in fancy mode with an
 * opener, never in a dry run or under --yes. Anything but Enter skips.
 */
export async function offerOpen(ctx: WizardContext, page: string, url: string): Promise<void> {
  if (!ctx.openUrl || ctx.dryRun || ctx.yes || !uiFor(ctx).fancy) return;
  const answer = await ctx.prompt.ask(`Press Enter to open ${page} in your browser (or s to skip)`);
  if (answer.trim() !== "") return;
  if (!ctx.openUrl(url)) uiFor(ctx).info(`Couldn't open a browser. The page is ${url}`);
}

function versionAtLeast(version: string, min: readonly [number, number]): boolean {
  const [maj = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return maj > min[0] || (maj === min[0] && minor >= min[1]);
}

/** Newest mtime of any file under `dir` (recursive). */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/** dist/ state for a source checkout: undefined when this isn't one. */
export function buildState(projectRoot: string): "missing" | "stale" | "fresh" | undefined {
  // Only a source checkout (never an installed package, even one that ships src/) is built.
  if (!sourceCheckoutMarker(projectRoot, existsSync)) return undefined;
  const src = join(projectRoot, "src");
  if (!existsSync(src) || !existsSync(join(projectRoot, "package.json"))) return undefined;
  const entries = ["index.js", "cli.js"].map((f) => join(projectRoot, "dist", f));
  if (!entries.every((f) => existsSync(f))) return "missing";
  const built = Math.min(...entries.map((f) => statSync(f).mtimeMs));
  return newestMtime(src) > built ? "stale" : "fresh";
}

// ------------------------------------------------------------------ steps

export async function stepNode(ctx: WizardContext): Promise<StepResult> {
  const step = "node";
  ctx.out(`Node ${ctx.node.version} at ${ctx.node.execPath}.`);
  if (!versionAtLeast(ctx.node.version, MIN_NODE)) {
    return { step, outcome: "failed", message: `crawlmark needs Node ${MIN_NODE.join(".")} or newer (it uses the built-in node:sqlite). Install it from https://nodejs.org/ and run setup again.` };
  }
  const state = buildState(ctx.paths.projectRoot);
  if (state === undefined) return { step, outcome: "done", message: "Node version OK (installed package; nothing to build)." };
  if (state === "fresh") return { step, outcome: "done", message: "Node version OK; dist/ is up to date." };
  ctx.out(state === "missing" ? "dist/ hasn't been built yet." : "Some files in src/ are newer than dist/.");
  if (!existsSync(join(ctx.paths.projectRoot, "node_modules"))) {
    return { step, outcome: "failed", message: `Dependencies aren't installed. Run \`npm install\` in ${ctx.paths.projectRoot}, then setup again.` };
  }
  if (!(await ctx.prompt.confirm("Build now (npm run build)?", true))) return { step, outcome: "skipped", message: "Not built; run `npm run build` before using the server." };
  if (ctx.dryRun) return { step, outcome: "done", message: `Dry run: would run \`npm run build\` in ${ctx.paths.projectRoot}.` };
  const r = await ctx.exec("npm", ["run", "build"], { inherit: true, cwd: ctx.paths.projectRoot });
  return r.code === 0 ? { step, outcome: "done", message: "Built dist/." } : { step, outcome: "failed", message: `\`npm run build\` failed (exit ${r.code}).` };
}

export async function stepDataForSeo(ctx: WizardContext, opts: CredentialStepOptions = {}): Promise<StepResult> {
  const step = "dataforseo";
  const ui = uiFor(ctx);
  const st = (await showStatus(ctx, ["dataforseo"])).get("dataforseo");
  const working = st?.state === "working";
  if (!opts.ticked && !(await ctx.prompt.confirm(working ? "Change the DataForSEO credentials?" : "Set up DataForSEO now?", !working))) {
    return { step, outcome: "skipped", message: working ? "Kept the current DataForSEO credentials." : "DataForSEO not set up (paid keyword, SERP and backlink tools stay unavailable)." };
  }
  ctx.out("DataForSEO powers keyword volumes, live rankings, competitors and backlinks.");
  ctx.out(`Find the API login and API password at ${LINKS.dataforseoApiAccess}.`);
  ctx.out("The API password is generated on that page. It is NOT the password you use to log in to the dashboard.");
  await offerOpen(ctx, "DataForSEO API access", LINKS.dataforseoApiAccess);
  const env = existingEnv(ctx);

  const mode = await ctx.prompt.choose(
    "Which DataForSEO API?",
    [
      { value: "sandbox", label: "sandbox: free sample data in the real format (recommended to start)" },
      { value: "live", label: "live: real data, billed per call to your DataForSEO balance" },
    ] as const,
    "sandbox",
  );
  if (mode === "live") {
    ctx.out("Warning: live mode costs money. Every paid tool call is charged to your DataForSEO balance (capped by the monthly budgets in .env).");
    if (!(await ctx.prompt.confirm("Use the live API?", false))) return { step, outcome: "skipped", message: "Left DataForSEO unchanged." };
  }
  const defaultUrl = mode === "live" ? DFS_LIVE_URL : DFS_SANDBOX_URL;
  // Keep a custom base URL of the same kind (e.g. a proxy) instead of resetting it.
  const current = env.DATAFORSEO_BASE_URL;
  const baseUrl = current && (current.includes("sandbox") === (mode === "sandbox")) ? current : defaultUrl;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const login = await ctx.prompt.ask("API login (usually your account email)", { default: env.DATAFORSEO_LOGIN });
    let password = await ctx.prompt.secret(env.DATAFORSEO_PASSWORD ? "API password (Enter keeps the current one)" : "API password");
    if (!password && env.DATAFORSEO_PASSWORD) password = env.DATAFORSEO_PASSWORD;
    if (!login || !password) {
      ui.fail("Both the API login and the API password are needed.");
      continue;
    }
    const check = await ui.spin(`Checking with DataForSEO's free account call (${new URL(baseUrl).hostname})...`, () => checkDataForSeoCredentials({ login, password, baseUrl }, ctx.fetch));
    if (check.credentialsWork === true) {
      const balance = check.balanceUsd === null ? "unknown" : `$${check.balanceUsd.toFixed(2)}`;
      ui.success(`Credentials work. Mode: ${check.mode}. Balance: ${balance}.`);
      saveEnv(ctx, { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password, DATAFORSEO_BASE_URL: baseUrl });
      markWorking(ctx, "dataforseo");
      return { step, outcome: "done", message: `DataForSEO works (${check.mode}, balance ${balance}).` };
    }
    if (check.credentialsWork === false) {
      ui.fail("DataForSEO rejected that login and password. Use the API password from the API access page, not your account password.");
      continue;
    }
    ui.warn(`Couldn't reach DataForSEO, so the credentials are untested: ${check.error}`);
    if (await ctx.prompt.confirm("Save them anyway?", false)) {
      saveEnv(ctx, { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password, DATAFORSEO_BASE_URL: baseUrl });
      return { step, outcome: "done", message: `Saved untested DataForSEO credentials; check later with \`${ctx.cliDisplay} setup --step dataforseo\`.` };
    }
    return { step, outcome: "failed", message: "DataForSEO unreachable; nothing saved." };
  }
  return { step, outcome: "failed", message: `DataForSEO credentials not saved after ${MAX_ATTEMPTS} attempts.` };
}

export async function stepAhrefs(ctx: WizardContext, opts: CredentialStepOptions = {}): Promise<StepResult> {
  const step = "ahrefs";
  const ui = uiFor(ctx);
  const st = (await showStatus(ctx, ["ahrefs"])).get("ahrefs");
  const working = st?.state === "working";
  if (!opts.ticked && !(await ctx.prompt.confirm(working ? "Change the Ahrefs API key?" : "Set up Ahrefs now?", !working))) {
    return { step, outcome: "skipped", message: working ? "Kept the current Ahrefs key." : "Ahrefs not set up." };
  }
  ctx.out("Ahrefs: keyword, ranking, competitor and backlink data (API v3, Lite plan or higher).");
  ctx.out(`Create a key under Account settings > API keys (${LINKS.ahrefsApiKeys}; workspace owner or admin).`);
  await offerOpen(ctx, "Ahrefs API keys", LINKS.ahrefsApiKeys);
  const current = existingEnv(ctx).AHREFS_API_KEY;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let key: string;
    try {
      key = await ctx.prompt.secret(current ? "Ahrefs API key (Enter keeps the current one)" : "Ahrefs API key");
    } catch (err) {
      if (err instanceof NeedsInputError) {
        const keySet = Boolean(current) || st?.data?.keySet === true;
        return { step, outcome: "skipped", message: keySet ? `Ahrefs key is set but untested; run ${ctx.cliDisplay} setup --step ahrefs` : `Ahrefs needs a key; run ${ctx.cliDisplay} setup --step ahrefs` };
      }
      throw err;
    }
    if (!key && current) key = current;
    if (!key) {
      ui.fail("No key entered.");
      continue;
    }
    const check = await ui.spin("Checking with Ahrefs (free limits-and-usage call)...", () => checkAhrefsKey(key, ctx.fetch));
    if (check.works === true) {
      const account = describeAhrefsAccount(check);
      ui.success(`Ahrefs works  ${account}`);
      saveEnv(ctx, { AHREFS_API_KEY: key });
      markWorking(ctx, "ahrefs");
      return { step, outcome: "done", message: `Ahrefs works (${account}).` };
    }
    if (check.works === false) {
      ui.fail(`Ahrefs rejected that key. Create one under Account settings > API keys (workspace owner or admin).`);
      continue;
    }
    ui.warn(`Couldn't reach Ahrefs, so the key is untested: ${check.error}`);
    if (await ctx.prompt.confirm("Save it anyway?", false)) {
      saveEnv(ctx, { AHREFS_API_KEY: key });
      return { step, outcome: "done", message: `Saved an untested Ahrefs key; check later with \`${ctx.cliDisplay} setup --step ahrefs\`.` };
    }
    return { step, outcome: "failed", message: "Ahrefs unreachable; nothing saved." };
  }
  return { step, outcome: "failed", message: `No working Ahrefs key after ${MAX_ATTEMPTS} attempts.` };
}

const SEMRUSH_API_UNITS = "https://www.semrush.com/accounts/subscription-info/api-units/";
const GOOGLE_SERVICE_ACCOUNTS = "https://console.cloud.google.com/iam-admin/serviceaccounts";
const GOOGLE_AUTH_OVERVIEW = "https://console.cloud.google.com/auth/overview";

export async function stepSemrush(ctx: WizardContext, opts: CredentialStepOptions = {}): Promise<StepResult> {
  const step = "semrush";
  const ui = uiFor(ctx);
  const st = (await showStatus(ctx, ["semrush"])).get("semrush");
  const working = works("semrush", st);
  if (!opts.ticked && !(await ctx.prompt.confirm(working ? "Change the Semrush API key?" : "Set up Semrush now?", !working))) {
    return { step, outcome: "skipped", message: working ? "Kept the current Semrush key." : "Semrush not set up." };
  }
  ctx.out("Semrush: keyword, ranking, competitor and backlink data (needs an SEO Business plan plus an API unit package).");
  ctx.out(`Find the v3 API key under Subscription info > API units (${SEMRUSH_API_UNITS}).`);
  await offerOpen(ctx, "Semrush API units", SEMRUSH_API_UNITS);
  const env = existingEnv(ctx);
  const current = env.SEMRUSH_API_KEY;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let key: string;
    try {
      key = await ctx.prompt.secret(current ? "Semrush API key, v3 (Enter keeps the current one)" : "Semrush API key (v3)");
    } catch (err) {
      if (err instanceof NeedsInputError) {
        const keySet = Boolean(current) || st?.data?.keySet === true;
        return { step, outcome: "skipped", message: keySet ? `Semrush key is set but untested; run ${ctx.cliDisplay} setup --step semrush` : `Semrush needs a key; run ${ctx.cliDisplay} setup --step semrush` };
      }
      throw err;
    }
    if (!key && current) key = current;
    if (!key) {
      ui.fail("No key entered.");
      continue;
    }
    const check = await ui.spin("Checking with Semrush (free API units balance call)...", () => checkSemrushKey(key, ctx.fetch));
    if (check.works === true) {
      if (check.unitsLeft === 0) ui.warn("Key accepted but the balance is 0 units; Semrush API needs an SEO Business plan and a unit package.");
      else ui.success(`Semrush key accepted  ${check.unitsLeft.toLocaleString("en-US")} API units left`);
      saveEnv(ctx, { SEMRUSH_API_KEY: key });
      markWorking(ctx, "semrush");
      await semrushV4(ctx);
      return { step, outcome: "done", message: `Semrush key accepted (${check.unitsLeft.toLocaleString("en-US")} API units left).` };
    }
    if (check.works === false) {
      ui.fail(`Semrush rejected that key${"errorCode" in check && check.errorCode ? ` (ERROR ${check.errorCode})` : ""}. Find the v3 key under Subscription info > API units.`);
      continue;
    }
    ui.warn(`Couldn't reach Semrush's balance check, so the key is untested: ${check.error}`);
    if (await ctx.prompt.confirm("Save it anyway?", false)) {
      saveEnv(ctx, { SEMRUSH_API_KEY: key });
      await semrushV4(ctx);
      return { step, outcome: "done", message: `Saved an untested Semrush key; check later with \`${ctx.cliDisplay} setup --step semrush\`.` };
    }
    return { step, outcome: "failed", message: "Semrush unreachable; nothing saved." };
  }
  return { step, outcome: "failed", message: `No accepted Semrush key after ${MAX_ATTEMPTS} attempts.` };
}

/** The optional v4 key (backlinks): saved untested, since Semrush has no free check for it (N15). Skipped under --yes. */
async function semrushV4(ctx: WizardContext): Promise<void> {
  if (ctx.yes) return;
  if (!(await ctx.prompt.confirm("Add a Semrush v4 key too? (backlinks use the v4 overview; without it they use the older v3 report)", false))) return;
  const v4 = await ctx.prompt.secret("Semrush API key (v4, from your profile > API keys)");
  if (!v4) {
    uiFor(ctx).info("No v4 key entered; backlinks keep using the v3 report.");
    return;
  }
  saveEnv(ctx, { SEMRUSH_V4_API_KEY: v4 });
  uiFor(ctx).info(
    ctx.dryRun
      ? "Semrush has no free check for v4 keys, so it would be checked the first time backlinks_summary runs."
      : "Saved; Semrush has no free check for v4 keys, so it's checked the first time backlinks_summary runs.",
  );
}

const GOOGLE_OPTIONS = [
  { value: "A", label: "A. OAuth with Google Workspace: sign in once, sees every property you can open, sign-ins don't expire" },
  { value: "B", label: "B. OAuth with a personal Gmail: same access, but the sign-in expires every 7 days (Testing mode)" },
  { value: "C", label: "C. Service account: never expires, works unattended; you add its email to each property" },
] as const;

function printCloudBasics(ctx: WizardContext): void {
  ctx.out("");
  ctx.out("In Google Cloud (https://console.cloud.google.com/), create or pick a project, then enable these APIs:");
  ctx.out(`  - Search Console API:          ${LINKS.enableSearchConsole}`);
  ctx.out(`  - Google Analytics Data API:   ${LINKS.enableAnalyticsData}`);
  ctx.out(`  - Google Analytics Admin API:  ${LINKS.enableAnalyticsAdmin}  (lists your GA4 properties)`);
  ctx.out(`  - Tag Manager API:             ${LINKS.enableTagManager}  (for gtm_audit)`);
}

function printServiceAccountSteps(ctx: WizardContext): void {
  ctx.out("");
  ctx.out("Option C, service account:");
  ctx.out(`  1. Open ${GOOGLE_SERVICE_ACCOUNTS} and create a service account (no roles needed).`);
  ctx.out("  2. On the account, open Keys > Add key > Create new key > JSON. A .json file downloads.");
  ctx.out("  3. Add the service account's email (shown after the check below) to each client's:");
  ctx.out(`     - Search Console property: Settings > Users and permissions (${LINKS.searchConsoleUsers})`);
  ctx.out("     - GA4 property: Admin > Property access management, role Viewer");
  ctx.out(`     - Tag Manager container (optional): Admin > User Management, Read (${LINKS.tagManager})`);
}

function printOAuthSteps(ctx: WizardContext, option: "A" | "B"): void {
  ctx.out("");
  ctx.out(`Option ${option}, OAuth:`);
  ctx.out(`  1. Configure the consent screen at ${GOOGLE_AUTH_OVERVIEW}`);
  if (option === "A") ctx.out("     Audience: Internal (the project must belong to your Workspace organization).");
  else {
    ctx.out("     Audience: External, publishing status Testing. Under Audience > Test users (https://console.cloud.google.com/auth/audience)");
    ctx.out("     add every Google account that will sign in. Testing sign-ins expire after 7 days; re-run `auth login` then.");
  }
  ctx.out("  2. Create an OAuth client of type Desktop app at https://console.cloud.google.com/auth/clients");
  ctx.out("  3. Enter its client ID and client secret below.");
}

async function googleOptionC(ctx: WizardContext, env: Record<string, string>): Promise<{ outcome: StepOutcome; message: string }> {
  const ui = uiFor(ctx);
  printServiceAccountSteps(ctx);
  await offerOpen(ctx, "Google Cloud service accounts", GOOGLE_SERVICE_ACCOUNTS);
  const dest = join(ctx.paths.home, KEY_FILE_REL);
  const current = env.GOOGLE_APPLICATION_CREDENTIALS ? expandPath(env.GOOGLE_APPLICATION_CREDENTIALS, ctx.paths.userHome, ctx.paths.home) : undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const answer = await ctx.prompt.ask("Path to the service-account JSON key (absolute, or starting with ~)", { default: current && existsSync(current) ? current : undefined });
    if (!answer) {
      ui.fail("A key file path is needed.");
      continue;
    }
    const src = expandPath(answer, ctx.paths.userHome, ctx.paths.cwd);
    if (!existsSync(src) || !statSync(src).isFile()) {
      ui.fail(`No file at ${src}.`);
      continue;
    }
    const check = await ui.spin("Checking the key with Google...", () => ctx.checkKeyFile(src));
    if (!check.ok) {
      ui.fail(`That key didn't work: ${check.problem}`);
      continue;
    }
    ui.success(`The key works. Service account: ${check.email}`);
    if (ctx.dryRun) ctx.out(`Dry run: would copy the key to ${dest} (mode 0600).`);
    else if (resolve(src) !== resolve(dest)) {
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      copyFileAtomic(src, dest, 0o600);
      ctx.out(`Copied the key to ${dest} (mode 0600).`);
    }
    saveEnv(ctx, { GOOGLE_AUTH_MODE: "service_account", GOOGLE_APPLICATION_CREDENTIALS: `./${KEY_FILE_REL.split("\\").join("/")}` });
    ctx.out(`Remember to add ${check.email} to each client's Search Console and GA4 property (see step 3 above).`);
    return { outcome: "done", message: `Google service account ${check.email} works.` };
  }
  return { outcome: "failed", message: `No working key after ${MAX_ATTEMPTS} attempts; Google not changed.` };
}

const OAUTH_CLIENT_ID_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/;

async function googleOAuth(ctx: WizardContext, env: Record<string, string>, option: "A" | "B"): Promise<{ outcome: StepOutcome; message: string }> {
  printOAuthSteps(ctx, option);
  await offerOpen(ctx, "Google Cloud's sign-in setup", GOOGLE_AUTH_OVERVIEW);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const clientId = await ctx.prompt.ask("OAuth client ID", { default: env.GOOGLE_OAUTH_CLIENT_ID });
    if (!OAUTH_CLIENT_ID_RE.test(clientId)) {
      uiFor(ctx).fail("That doesn't look like an OAuth client ID (it ends in .apps.googleusercontent.com).");
      continue;
    }
    let secret = await ctx.prompt.secret(env.GOOGLE_OAUTH_CLIENT_SECRET ? "OAuth client secret (Enter keeps the current one)" : "OAuth client secret");
    if (!secret && env.GOOGLE_OAUTH_CLIENT_SECRET) secret = env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!secret) {
      ctx.out("The client secret is needed.");
      continue;
    }
    saveEnv(ctx, { GOOGLE_AUTH_MODE: "oauth", GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: secret });
    if (!(await ctx.prompt.confirm("Sign in to Google now (opens your browser)?", true))) {
      return { outcome: "done", message: `OAuth client saved. Sign in later with \`${ctx.cliDisplay} auth login\`.` };
    }
    if (ctx.dryRun) {
      ctx.out(`Dry run: would run \`${ctx.cliDisplay} auth login\`.`);
      return { outcome: "done", message: "Dry run: OAuth sign-in not started." };
    }
    const r = await ctx.cli(["auth", "login"], { inherit: true });
    return r.code === 0
      ? { outcome: "done", message: "Signed in to Google." }
      : { outcome: "failed", message: `Sign-in didn't finish (exit ${r.code}). Try again with \`${ctx.cliDisplay} auth login\`.` };
  }
  return { outcome: "failed", message: `OAuth client not saved after ${MAX_ATTEMPTS} attempts.` };
}

function printProperties(ctx: WizardContext, st: Map<IntegrationId, IntegrationStatus>): void {
  for (const id of ["gsc", "ga4", "tagmanager"] as const) {
    const s = st.get(id);
    const sample = s?.data?.sample;
    if (!Array.isArray(sample) || sample.length === 0) continue;
    ctx.out(`${s!.label}${typeof s!.data?.count === "number" && s!.data.count > sample.length ? ` (first ${sample.length} of ${s!.data.count})` : ""}:`);
    for (const item of sample) {
      if (typeof item === "string") ctx.out(`  - ${item}`);
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        ctx.out(`  - ${[o.name, o.id ?? o.publicId].filter(Boolean).join("  ")}`);
      }
    }
  }
}

export async function stepGoogle(ctx: WizardContext): Promise<StepResult> {
  const step = "google";
  const st = await showStatus(ctx, ["google", "gsc", "ga4", "tagmanager"]);
  const working = st.get("google")?.state === "working";
  if (!(await ctx.prompt.confirm(working ? "Change the Google setup?" : "Set up Google (Search Console, GA4, Tag Manager) now?", !working))) {
    return { step, outcome: "skipped", message: working ? "Kept the current Google setup." : "Google not set up (Search Console, GA4 and Tag Manager stay unavailable)." };
  }
  const env = existingEnv(ctx);
  const currentMode = env.GOOGLE_AUTH_MODE || (env.GOOGLE_APPLICATION_CREDENTIALS ? "service_account" : env.GOOGLE_OAUTH_CLIENT_ID ? "oauth" : "");
  const option = await ctx.prompt.choose("How should crawlmark sign in to Google? (README > Google compares them)", GOOGLE_OPTIONS, currentMode === "oauth" ? "A" : "C");
  printCloudBasics(ctx);
  const r = option === "C" ? await googleOptionC(ctx, env) : await googleOAuth(ctx, env, option);
  if (r.outcome !== "done") return { step, ...r };

  ctx.out("");
  ctx.out(ctx.dryRun ? "Current Google status (dry run: nothing was saved):" : "Checking what this Google identity can see...");
  const after = await showStatus(ctx, ["google", "gsc", "ga4", "tagmanager"], { refresh: true });
  printProperties(ctx, after);
  return { step, ...r };
}

export async function stepPsi(ctx: WizardContext): Promise<StepResult> {
  const step = "psi";
  const st = (await showStatus(ctx, ["psi"])).get("psi");
  const set = st?.state === "configured" || st?.state === "working";
  if (!(await ctx.prompt.confirm(set ? "Replace the PageSpeed Insights API key?" : "Add a PageSpeed Insights API key (optional, adds real-user speed data)?", false))) {
    return { step, outcome: "skipped", message: set ? "Kept the current PageSpeed Insights key." : "No PageSpeed Insights key (Lighthouse still runs locally)." };
  }
  ctx.out(`1. Enable the PageSpeed Insights API: ${LINKS.enablePageSpeed}`);
  ctx.out(`2. Create an API key under APIs & Services > Credentials: ${LINKS.credentials}`);
  ctx.out("   (Optionally restrict it to the PageSpeed Insights API; don't add a website restriction.)");
  await offerOpen(ctx, "the PageSpeed Insights API page", LINKS.enablePageSpeed);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const key = await ctx.prompt.secret("PageSpeed Insights API key");
    if (!key) {
      uiFor(ctx).fail("No key entered.");
      continue;
    }
    const check = await uiFor(ctx).spin("Checking the key with one PageSpeed request (can take up to a minute)...", () => checkPsiKey(key, ctx.fetch));
    if (!check.ok) {
      uiFor(ctx).fail(check.problem);
      continue;
    }
    if (uiFor(ctx).fancy) uiFor(ctx).success("The PageSpeed Insights key works.");
    if (check.note) uiFor(ctx).info(check.note);
    saveEnv(ctx, { PSI_API_KEY: key });
    return { step, outcome: "done", message: "PageSpeed Insights key works." };
  }
  return { step, outcome: "failed", message: `No working PageSpeed Insights key after ${MAX_ATTEMPTS} attempts.` };
}

/**
 * Phase 12: the CrUX History key (`--step crux` only). Blank uses PSI_API_KEY when its project
 * has the Chrome UX Report API enabled. The check is one free query for a public origin
 * (https://developer.chrome.com), so no client data is sent.
 */
export async function stepCrux(ctx: WizardContext): Promise<StepResult> {
  const step = "crux";
  const st = (await showStatus(ctx, ["crux"])).get("crux");
  const set = Boolean(st && st.state !== "missing");
  if (!(await ctx.prompt.confirm(set ? "Replace the CrUX History key?" : "Add a Chrome UX Report (CrUX) API key for Core Web Vitals history?", !set))) {
    return { step, outcome: "skipped", message: set ? "Kept the current CrUX setup." : "No CrUX key (crux_history and the cwv report section stay unavailable)." };
  }
  ctx.out(`1. Enable the Chrome UX Report API: ${LINKS.enableCrux}`);
  ctx.out(`2. Create an API key under APIs & Services > Credentials (or reuse your PageSpeed key): ${LINKS.credentials}`);
  ctx.out("   (If you restrict the key, allow the Chrome UX Report API.)");
  await offerOpen(ctx, "the Chrome UX Report API page", LINKS.enableCrux);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const key = await ctx.prompt.secret("CrUX API key (blank: use PSI_API_KEY)");
    if (!key) {
      const psi = existingEnv(ctx).PSI_API_KEY || process.env.PSI_API_KEY;
      if (!psi) {
        uiFor(ctx).fail("No key entered, and there's no PSI_API_KEY to use instead.");
        continue;
      }
      const check = await uiFor(ctx).spin("Checking PSI_API_KEY with one free CrUX request...", () => checkCruxKey(psi, ctx.fetch, "PSI_API_KEY"));
      if (!check.ok) return { step, outcome: "failed", message: check.problem };
      return { step, outcome: "done", message: "PSI_API_KEY works for CrUX History; nothing saved." };
    }
    const check = await uiFor(ctx).spin("Checking the key with one free CrUX request...", () => checkCruxKey(key, ctx.fetch));
    if (!check.ok) {
      uiFor(ctx).fail(check.problem);
      continue;
    }
    saveEnv(ctx, { CRUX_API_KEY: key });
    return { step, outcome: "done", message: "CrUX History key works." };
  }
  return { step, outcome: "failed", message: `No working CrUX key after ${MAX_ATTEMPTS} attempts.` };
}

/**
 * Run crawlmark-cli in a child process. Plain mode gives it the terminal, as
 * before; fancy mode captures its output behind a spinner and then prints it
 * inside the frame (stderr only when it failed).
 */
async function runCliStep(ctx: WizardContext, label: string, args: string[]): Promise<ExecResult> {
  const ui = uiFor(ctx);
  if (!ui.fancy) return ctx.cli(args, { inherit: true });
  const r = await ui.spin(label, () => ctx.cli(args));
  const text = (r.code === 0 ? r.stdout : `${r.stdout}\n${r.stderr}`).trim();
  for (const line of text ? text.split(/\r?\n/) : []) ctx.out(line);
  return r;
}

export async function stepDiscovery(ctx: WizardContext): Promise<StepResult> {
  const step = "discovery";
  const st = await showStatus(ctx, ["google", "clients"]);
  if (st.get("google")?.state !== "working") {
    return { step, outcome: "skipped", message: `Google isn't working yet, so there's nothing to discover. Add clients by hand with \`${ctx.cliDisplay} clients add <domain>\`.` };
  }
  if (!(await ctx.prompt.confirm("Find your clients in Search Console and GA4 and add them to clients.yaml?", true))) {
    return { step, outcome: "skipped", message: "Discovery skipped (it also runs on first use of list_clients)." };
  }
  if (ctx.dryRun) ctx.out(`Dry run: would run \`${ctx.cliDisplay} clients list --refresh\`.`);
  else {
    const r = await runCliStep(ctx, "Discovering clients...", ["clients", "list", "--refresh"]);
    if (r.code !== 0) return { step, outcome: "failed", message: `Discovery failed (exit ${r.code}); see the output above.` };
  }
  if (await ctx.prompt.confirm("Infer each client's brand terms from Search Console (free, no DataForSEO) and save the high-confidence ones?", true)) {
    if (ctx.dryRun) ctx.out(`Dry run: would run \`${ctx.cliDisplay} brand suggest --all --no-paid --apply\`.`);
    else {
      const r = await runCliStep(ctx, "Inferring brand terms...", ["brand", "suggest", "--all", "--no-paid", "--apply"]);
      if (r.code !== 0) uiFor(ctx).warn(`Brand-term inference failed (exit ${r.code}); you can run it later with \`${ctx.cliDisplay} brand suggest --all --no-paid\`.`);
    }
  }
  return { step, outcome: "done", message: ctx.dryRun ? "Dry run: discovery not run." : "Clients discovered and saved to clients.yaml." };
}

export { isNpxCache, serverLaunch } from "./apps.js";

/** Register crawlmark with the AI apps the user picks (src/setup/apps.ts). */
export async function stepRegister(ctx: WizardContext): Promise<StepResult> {
  return registerApps(ctx);
}

// ------------------------------------------------------------------ SEO data providers (Phase 9)

/** Provider credential steps, in the order the full run takes them (task 7 adds Semrush). */
const PROVIDER_STEPS: readonly ProviderId[] = ["dataforseo", "ahrefs", "semrush"];
const PROVIDER_ORDER: readonly ProviderId[] = ["dataforseo", "ahrefs", "semrush"];

const PROVIDER_HINTS: Record<ProviderId, string> = {
  dataforseo: "pay per call; free sandbox; also live SERPs, on-page, crawls",
  ahrefs: "API v3, Lite plan or higher",
  semrush: "Business plan + API unit package",
};

/** What the wizard says when a provider isn't set up and --yes can't ask for its key. */
const NEEDS_KEY: Record<ProviderId, (cli: string) => string> = {
  dataforseo: (cli) => `DataForSEO needs a login; run ${cli} setup --step dataforseo`,
  ahrefs: (cli) => `Ahrefs needs a key; run ${cli} setup --step ahrefs`,
  semrush: (cli) => `Semrush needs a key; run ${cli} setup --step semrush`,
};

/** How to forget a provider's credentials (the wizard never deletes them: D10). */
const KEY_VARS: Record<ProviderId, string> = {
  dataforseo: "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD",
  ahrefs: "AHREFS_API_KEY",
  semrush: "SEMRUSH_API_KEY (and SEMRUSH_V4_API_KEY)",
};

const STATE_WORD: Record<IntegrationStatus["state"], string> = { working: "working", configured: "set, untested", error: "error", missing: "not set up" };

/** Read status rows without printing them (under a spinner in fancy mode). */
async function readStatus(ctx: WizardContext, only: IntegrationId[]): Promise<Map<IntegrationId, IntegrationStatus>> {
  const map = new Map<IntegrationId, IntegrationStatus>();
  try {
    const report = await uiFor(ctx).spin("Checking the current status...", () => ctx.status(only), { plain: false });
    for (const i of report.integrations) map.set(i.id, i);
  } catch (err) {
    ctx.out(`  (Couldn't read the current status: ${(err as Error).message})`);
  }
  return map;
}

const providerIds = (): ProviderId[] => PROVIDER_ORDER.filter((id) => PROVIDER_STEPS.includes(id));
/** A provider's setup_status row id (every provider with a credential step has one). */
const rowId = (id: ProviderId) => id as IntegrationId;
/** A provider counts as working: its row is working, or (Semrush) its key was accepted with units left and only the v4 key is untested. */
export const works = (id: ProviderId, s: IntegrationStatus | undefined) =>
  s?.state === "working" || (id === "semrush" && s?.state === "configured" && typeof s.data?.unitsLeft === "number" && s.data.unitsLeft > 0);
const hasKey = (id: ProviderId, s: IntegrationStatus | undefined) => (id === "dataforseo" ? s !== undefined && s.state !== "missing" : s?.data?.keySet === true);

function describeDefault(seo: IntegrationStatus | undefined): string {
  const d = seo?.data as { default?: ProviderId | null; source?: string; invalidValue?: string } | undefined;
  if (!d) return "Default provider: unknown.";
  if (d.default === null || d.default === undefined) return `Default provider: invalid value ${quoteProviderValue(displayProviderValue(d.invalidValue ?? ""))} in SEO_DATA_PROVIDER.`;
  const from = d.source === "envFile" ? ".env" : d.source === "env" ? "shell env" : "default";
  return `Default provider: ${PROVIDER_LABELS[d.default]} (${from}).`;
}

/**
 * provider:pick. Shows the providers' status and the current default, then asks which
 * providers the user has. Pre-ticked: the ones with a key (DataForSEO alone on a fresh home;
 * none under --yes). Never deletes a key (D10).
 */
export async function stepProviderPick(ctx: WizardContext): Promise<{ result: StepResult; statuses: Map<IntegrationId, IntegrationStatus> }> {
  const ui = uiFor(ctx);
  const ids = providerIds();
  const st = await readStatus(ctx, ["seoprovider", ...ids.map(rowId)]);
  ctx.out(`SEO data providers: ${ids.map((id) => `${PROVIDER_LABELS[id]} (${(works(id, st.get(rowId(id))) ? "working" : STATE_WORD[st.get(rowId(id))?.state ?? "missing"])})`).join(", ")}`);
  ctx.out(describeDefault(st.get("seoprovider")));
  ctx.out("Keyword volumes, rankings, competitors and backlinks come from a paid provider. Pick the ones you have an API key for (none is required).");
  const keyed = ids.filter((id) => hasKey(id, st.get(rowId(id))));
  const defaults = ctx.yes ? keyed : keyed.length ? keyed : (["dataforseo"] as ProviderId[]);
  const choices = ids.map((id) => ({ value: id, label: PROVIDER_LABELS[id], hint: PROVIDER_HINTS[id] }));
  const picked = ctx.prompt.multiselect ? await ctx.prompt.multiselect("Which SEO data providers do you have?", choices, defaults) : [...defaults];
  const selected = new Set(picked);
  const working = new Set(ids.filter((id) => selected.has(id) && works(id, st.get(rowId(id)))));
  ctx.providers = { selected, working: new Set([...(ctx.providers?.working ?? []), ...working]) };
  if (selected.size === 0) ui.info("No paid provider selected. Free tools (Search Console, GA4, audits) still work. Add one later with setup --step provider.");
  if (!selected.has("dataforseo") && (selected.has("ahrefs") || selected.has("semrush"))) {
    ui.warn("Live SERPs, on-page checks and crawls need DataForSEO; without it those parts of run_audit and serp_check are skipped.");
  }
  for (const id of keyed.filter((k) => !selected.has(k))) {
    ui.info(`${PROVIDER_LABELS[id]} ${id === "dataforseo" ? "login" : "key"} kept in .env but not used as the default. Remove ${KEY_VARS[id]} from .env to forget it.`);
  }
  const names = ids.filter((id) => selected.has(id)).map((id) => PROVIDER_LABELS[id]);
  return { result: { step: "provider", outcome: "done", message: names.length ? `Selected: ${names.join(", ")}.` : "No paid provider selected." }, statuses: st };
}

/**
 * provider:default. W = the working providers (still ticked, when this run had a pick).
 * 0: nothing written. 1: that one, written only if it differs from the effective default.
 * 2+: a select, pre-selecting the current default when it works, else the first of
 * dataforseo, ahrefs, semrush. --yes takes the pre-selection (D9).
 */
export async function stepProviderDefault(ctx: WizardContext): Promise<StepResult> {
  const step = "provider";
  const ui = uiFor(ctx);
  const st = await readStatus(ctx, ["seoprovider", ...providerIds().map(rowId)]);
  const selected = ctx.providers?.selected;
  const workingNow = new Set<ProviderId>([...(ctx.providers?.working ?? []), ...providerIds().filter((id) => works(id, st.get(rowId(id))))]);
  const W = PROVIDER_ORDER.filter((id) => workingNow.has(id) && (!selected || selected.has(id)));
  const seo = st.get("seoprovider")?.data as { default?: ProviderId | null; invalidValue?: string } | undefined;
  // Unset counts as dataforseo; an invalid value matches nothing, so any working provider replaces it.
  const effective: ProviderId | null = seo?.invalidValue !== undefined || seo?.default === null ? null : (seo?.default ?? "dataforseo");
  const dfsNote = `Live SERPs, on-page checks and crawls still use DataForSEO${W.includes("dataforseo") ? "" : " (not set up)"}.`;
  // A valid default whose key is set stays the default unless it was unticked or its key was rejected
  // (D2, D9): a check that failed this run (network, 5xx, 429, a Semrush balance of 0) never moves
  // paid calls to another account. Under --yes it is always kept; interactively, when it didn't pass this run.
  const effRow = effective ? st.get(rowId(effective)) : undefined;
  const keepable =
    effective !== null &&
    PROVIDER_STEPS.includes(effective) &&
    (!selected || selected.has(effective)) &&
    hasKey(effective, effRow) &&
    effRow?.state !== "error";
  if (keepable && (ctx.yes || !W.includes(effective))) {
    const why = W.includes(effective) ? "" : " Its key is set but wasn't confirmed working in this run, so it stays the default.";
    return { step, outcome: "done", message: `Default: ${PROVIDER_LABELS[effective]} (kept).${why} ${dfsNote}`, defaultProvider: effective };
  }
  if (W.length === 0) {
    return { step, outcome: "skipped", message: "No working provider yet; paid tools stay unavailable." };
  }
  let choice: ProviderId;
  let message: string;
  if (W.length === 1) {
    choice = W[0]!;
    message = `Default: ${PROVIDER_LABELS[choice]} (the only provider set up).`;
  } else {
    ctx.out("Each client can override this (dataProvider in clients.yaml, or clients set <client> --provider).");
    const pre = effective && W.includes(effective) ? effective : W[0]!;
    choice = await ctx.prompt.choose(
      "Default provider for keyword, competitor and backlink data",
      W.map((id) => ({ value: id, label: id })),
      pre,
    );
    message = `Default: ${PROVIDER_LABELS[choice]}.`;
  }
  if (choice !== effective) saveEnv(ctx, { SEO_DATA_PROVIDER: choice });
  else if (ctx.shellEnvKeys.has("SEO_DATA_PROVIDER")) {
    ui.warn("Warning: your shell (or the MCP client config) also sets SEO_DATA_PROVIDER, which overrides .env. Unset it there for the .env value to take effect.");
  }
  return { step, outcome: "done", message: `${message} ${dfsNote}`, defaultProvider: choice };
}

type StepRun = (ctx: WizardContext, opts?: CredentialStepOptions) => Promise<StepResult>;

const STEPS: Record<Exclude<StepName, "provider">, { title: string; run: StepRun }> = {
  node: { title: "Node and build", run: stepNode },
  dataforseo: { title: "DataForSEO", run: stepDataForSeo },
  ahrefs: { title: "Ahrefs", run: stepAhrefs },
  semrush: { title: "Semrush", run: stepSemrush },
  google: { title: "Google", run: stepGoogle },
  psi: { title: "PageSpeed Insights key (optional)", run: stepPsi },
  crux: { title: "CrUX History key (optional)", run: stepCrux },
  discovery: { title: "Clients", run: stepDiscovery },
  register: { title: "Register with Claude", run: stepRegister },
};

/** A run's phases: the public steps plus the provider pick and default phases (not --step values). */
export type Phase = Exclude<StepName, "provider"> | "provider:pick" | "provider:default";

const isProviderStep = (p: Phase): p is ProviderId & Phase => (PROVIDER_STEPS as readonly string[]).includes(p);

/** The run plan (spec 9.6) for a full run or one --step. */
export function runPlan(step?: StepName): Phase[] {
  const creds = PROVIDER_STEPS as readonly Phase[];
  if (!step) return ["node", "provider:pick", ...creds, "provider:default", "google", "psi", "discovery", "register"];
  if (step === "provider") return ["provider:pick", ...creds, "provider:default"];
  if (isProviderStep(step)) return [step, "provider:default"];
  return [step];
}

const SUMMARY_LABELS: Record<Exclude<StepName, "register">, string> = {
  node: "Node",
  provider: "Data provider",
  dataforseo: "DataForSEO",
  ahrefs: "Ahrefs",
  semrush: "Semrush",
  google: "Google",
  psi: "PageSpeed",
  crux: "CrUX",
  discovery: "Clients",
};

const APP_OUTCOME: Record<AppOutcome["status"], StepOutcome> = {
  registered: "done",
  already: "done",
  skipped: "skipped",
  manual: "skipped",
  "dry-run": "skipped",
  failed: "failed",
};

/** "Registered: A, B. Already set up: C." for the fancy register result (pure). */
export function appsTally(apps: AppOutcome[]): string {
  const groups: [string, AppOutcome["status"][]][] = [
    ["Registered", ["registered"]],
    ["Already set up", ["already"]],
    ["Dry run, not changed", ["dry-run"]],
    ["Skipped", ["skipped", "manual"]],
    ["Failed", ["failed"]],
  ];
  const parts = groups.flatMap(([label, statuses]) => {
    const names = apps.filter((a) => statuses.includes(a.status)).map((a) => APP_LABELS[a.id]);
    return names.length ? [`${label}: ${names.join(", ")}.`] : [];
  });
  return parts.join(" ") || "No apps picked; the snippets above add crawlmark by hand.";
}

/** The fancy summary: one cell per step and app, then numbered next steps (pure). */
export function summarize(ctx: Pick<WizardContext, "cliDisplay" | "dryRun">, results: StepResult[]): { rows: SummaryRow[]; next: string[] } {
  const rows: SummaryRow[] = [];
  const next: string[] = [];
  const defaultProvider = results.find((r) => r.step === "provider" && r.defaultProvider)?.defaultProvider;
  for (const r of results) {
    if (r.step === "register") {
      for (const a of r.apps ?? []) rows.push({ label: APP_LABELS[a.id], outcome: APP_OUTCOME[a.status], ...(a.status === "dry-run" ? { note: "(dry run)" } : {}) });
      const changed = new Set((r.apps ?? []).filter((a) => a.status === "registered").map((a) => a.id));
      if (changed.has("claude-desktop")) next.push("Restart Claude Desktop");
      if (changed.has("cursor")) next.push("Restart Cursor (or reload its MCP servers)");
      if (changed.has("codex")) next.push("Restart Codex");
      continue;
    }
    // The default is shown as "(default)" on its provider's cell, not as a cell of its own.
    if (r.step === "provider") continue;
    const note = r.step === defaultProvider ? "(default)" : r.outcome === "skipped" ? "(skipped)" : undefined;
    rows.push({ label: SUMMARY_LABELS[r.step], outcome: r.outcome, ...(note ? { note } : {}) });
    if (r.outcome === "failed" || r.outcome === "needs-input") next.unshift(`Fix ${SUMMARY_LABELS[r.step]}: ${ctx.cliDisplay} setup --step ${r.step}`);
  }
  next.push("In Claude, run the getting-started prompt");
  next.push(`Change one step: ${ctx.cliDisplay} setup --step <${STEP_NAMES.join("|")}>`);
  if (results.some((r) => r.step === "provider")) next.push(`Change providers: ${ctx.cliDisplay} setup --step provider`);
  return { rows, next };
}

/**
 * Phase 10: a dim tip under a step's result (fancy only; plain mode's tip() prints nothing).
 * Commands use ctx.cliDisplay, so a checkout, a global install and npx each show the right one.
 */
export function tipFor(ctx: Pick<WizardContext, "cliDisplay">, result: StepResult): string | undefined {
  const cli = ctx.cliDisplay;
  const { step, outcome } = result;
  if (outcome === "done") {
    if (step === "google") return `To switch accounts later: ${cli} setup --step google`;
    if (step === "dataforseo") return `To switch between sandbox and live later: ${cli} setup --step dataforseo`;
    if (step === "provider" && result.defaultProvider) return `To use another provider for one client: ${cli} clients set <domain> --provider <name>`;
    if (step === "discovery") return `To add a client by hand: ${cli} clients add <domain>`;
    if (step === "register") return `To check everything later: ${cli} setup status`;
  }
  if (outcome === "skipped" && step === "psi") return `To add a PageSpeed key later: ${cli} setup --step psi`;
  return undefined;
}

/** The fancy box's examples: the user's clients when the context can read them, else example.com. A read error counts as none. */
function examplesFor(ctx: WizardContext) {
  let clients: ExampleClient[] | undefined;
  try {
    clients = ctx.exampleClients?.();
  } catch {
    clients = undefined;
  }
  return tryAskingExamples(clients, ctx.cliDisplay);
}

/**
 * Run the plan for every step (or one). Steps never throw: failures and missing input are
 * results. Ctrl-C stops the run. With a provider pick, a credential step whose provider
 * wasn't ticked is "Not selected." (full run) or left out (--step provider), and one that
 * already works runs no prompt.
 */
export async function runWizard(ctx: WizardContext, opts: { step?: StepName; introShown?: boolean } = {}): Promise<StepResult[]> {
  const ui = uiFor(ctx);
  // The returning-user menu (src/setup/menu.ts) shows the intro itself before it runs a step.
  if (!opts.introShown) ui.intro({ command: ctx.command ?? "setup", version: ctx.version ?? "", home: ctx.paths.home, dryRun: ctx.dryRun });
  const phases = runPlan(opts.step);
  const results: StepResult[] = [];
  let picked: Map<IntegrationId, IntegrationStatus> | undefined;
  let index = 0;
  for (const name of phases) {
    let result: StepResult | undefined;
    let record = true;
    const run = async (title: string, fn: () => Promise<StepResult>): Promise<StepResult> => {
      index++;
      ui.step(title, opts.step ? undefined : { index, total: phases.length });
      try {
        return await fn();
      } catch (err) {
        if (err instanceof PromptAbortedError) throw err;
        const step: StepName = name === "provider:pick" || name === "provider:default" ? "provider" : name;
        return err instanceof NeedsInputError ? { step, outcome: "needs-input" as const, message: err.message } : { step, outcome: "failed" as const, message: (err as Error).message };
      }
    };
    if (name === "provider:pick") {
      result = await run("SEO data providers", async () => {
        const r = await stepProviderPick(ctx);
        picked = r.statuses;
        return r.result;
      });
      // The pick's line is shown; the summary's "provider" entry is the default phase's result.
      record = false;
    } else if (name === "provider:default") {
      result = await run("Default data provider", () => stepProviderDefault(ctx));
    } else if (isProviderStep(name) && picked) {
      const id = name as ProviderId;
      const selected = ctx.providers?.selected?.has(id) ?? false;
      const working = works(id, picked.get(rowId(id)));
      if (opts.step === "provider" && (!selected || working)) continue;
      if (!selected) {
        result = await run(STEPS[name].title, async () => ({ step: name, outcome: "skipped", message: ctx.yes && !hasKey(id, picked!.get(rowId(id))) ? NEEDS_KEY[id](ctx.cliDisplay) : "Not selected." }));
      } else if (working) {
        result = await run(STEPS[name].title, async () => ({ step: name, outcome: "done", message: `${PROVIDER_LABELS[id]} already works; change it with ${ctx.cliDisplay} setup --step ${id}.` }));
      } else {
        result = await run(STEPS[name].title, () => STEPS[name].run(ctx, { ticked: true }));
      }
    } else {
      const step = name as Exclude<Phase, "provider:pick" | "provider:default">;
      result = await run(STEPS[step].title, () => STEPS[step].run(ctx));
    }
    // Fancy mode already showed each app's line; its result is a short tally instead of all of them again.
    ui.result(result.outcome, ui.fancy && result.apps ? appsTally(result.apps) : result.message);
    if (ui.fancy) {
      const tip = tipFor(ctx, result);
      if (tip) ui.tip(tip);
    }
    if (record) results.push(result);
    if (name === "node" && result.outcome === "failed") break;
  }
  const { rows, next } = summarize(ctx, results);
  ui.summary({
    steps: results.map((r) => ({ step: r.step, outcome: r.outcome })),
    rows,
    next,
    rerun: `Re-run one step with \`${ctx.cliDisplay} setup --step <${STEP_NAMES.join("|")}>\`. In Claude, the setup_status tool shows the same checks.`,
    // Fancy only: plain mode prints exactly what it did before Phase 10.
    ...(ui.fancy && (!opts.step || opts.step === "discovery") ? { tryAsking: examplesFor(ctx) } : {}),
  });
  ui.outro(results.some((r) => r.outcome === "failed") ? "Finished, with problems above" : "Done");
  return results;
}
