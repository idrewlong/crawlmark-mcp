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
import { checkDataForSeoCredentials } from "../providers/dataforseo.js";
import { checkPsiKey } from "./checks.js";
import { NeedsInputError, PromptAbortedError, type Prompter } from "./prompter.js";
import { uiFor, type SummaryRow, type Ui } from "./ui.js";
import { DFS_LIVE_URL, DFS_SANDBOX_URL } from "../lib/env.js";
import { LINKS, type IntegrationId, type IntegrationStatus, type SetupStatusReport } from "./status.js";

export const STEP_NAMES = ["node", "dataforseo", "google", "psi", "discovery", "register"] as const;
export type StepName = (typeof STEP_NAMES)[number];

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
}

export type StepOutcome = "done" | "skipped" | "failed" | "needs-input";

export interface StepResult {
  step: StepName;
  outcome: StepOutcome;
  message: string;
  /** The register step: what happened with each app. */
  apps?: AppOutcome[];
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

export async function stepDataForSeo(ctx: WizardContext): Promise<StepResult> {
  const step = "dataforseo";
  const ui = uiFor(ctx);
  const st = (await showStatus(ctx, ["dataforseo"])).get("dataforseo");
  const working = st?.state === "working";
  if (!(await ctx.prompt.confirm(working ? "Change the DataForSEO credentials?" : "Set up DataForSEO now?", !working))) {
    return { step, outcome: "skipped", message: working ? "Kept the current DataForSEO credentials." : "DataForSEO not set up (paid keyword, SERP and backlink tools stay unavailable)." };
  }
  ctx.out("DataForSEO powers keyword volumes, live rankings, competitors and backlinks.");
  ctx.out(`Find the API login and API password at ${LINKS.dataforseoApiAccess}.`);
  ctx.out("The API password is generated on that page. It is NOT the password you use to log in to the dashboard.");
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
  ctx.out("  1. Open https://console.cloud.google.com/iam-admin/serviceaccounts and create a service account (no roles needed).");
  ctx.out("  2. On the account, open Keys > Add key > Create new key > JSON. A .json file downloads.");
  ctx.out("  3. Add the service account's email (shown after the check below) to each client's:");
  ctx.out(`     - Search Console property: Settings > Users and permissions (${LINKS.searchConsoleUsers})`);
  ctx.out("     - GA4 property: Admin > Property access management, role Viewer");
  ctx.out(`     - Tag Manager container (optional): Admin > User Management, Read (${LINKS.tagManager})`);
}

function printOAuthSteps(ctx: WizardContext, option: "A" | "B"): void {
  ctx.out("");
  ctx.out(`Option ${option}, OAuth:`);
  ctx.out("  1. Configure the consent screen at https://console.cloud.google.com/auth/overview");
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

const STEPS: Record<StepName, { title: string; run: (ctx: WizardContext) => Promise<StepResult> }> = {
  node: { title: "Node and build", run: stepNode },
  dataforseo: { title: "DataForSEO", run: stepDataForSeo },
  google: { title: "Google", run: stepGoogle },
  psi: { title: "PageSpeed Insights key (optional)", run: stepPsi },
  discovery: { title: "Clients", run: stepDiscovery },
  register: { title: "Register with Claude", run: stepRegister },
};

const SUMMARY_LABELS: Record<Exclude<StepName, "register">, string> = {
  node: "Node",
  dataforseo: "DataForSEO",
  google: "Google",
  psi: "PageSpeed",
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
  for (const r of results) {
    if (r.step === "register") {
      for (const a of r.apps ?? []) rows.push({ label: APP_LABELS[a.id], outcome: APP_OUTCOME[a.status], ...(a.status === "dry-run" ? { note: "(dry run)" } : {}) });
      const changed = new Set((r.apps ?? []).filter((a) => a.status === "registered").map((a) => a.id));
      if (changed.has("claude-desktop")) next.push("Restart Claude Desktop");
      if (changed.has("cursor")) next.push("Restart Cursor (or reload its MCP servers)");
      if (changed.has("codex")) next.push("Restart Codex");
      continue;
    }
    rows.push({ label: SUMMARY_LABELS[r.step], outcome: r.outcome, ...(r.outcome === "skipped" ? { note: "(skipped)" } : {}) });
    if (r.outcome === "failed" || r.outcome === "needs-input") next.unshift(`Fix ${SUMMARY_LABELS[r.step]}: ${ctx.cliDisplay} setup --step ${r.step}`);
  }
  next.push("In Claude, run the getting-started prompt");
  next.push(`Change one step: ${ctx.cliDisplay} setup --step <${STEP_NAMES.join("|")}>`);
  return { rows, next };
}

/** Run every step (or one). Steps never throw: failures and missing input are results. Ctrl-C stops the run. */
export async function runWizard(ctx: WizardContext, opts: { step?: StepName } = {}): Promise<StepResult[]> {
  const ui = uiFor(ctx);
  ui.intro({ command: ctx.command ?? "setup", version: ctx.version ?? "", home: ctx.paths.home, dryRun: ctx.dryRun });
  const names = opts.step ? [opts.step] : STEP_NAMES;
  const results: StepResult[] = [];
  for (const [i, name] of names.entries()) {
    ui.step(STEPS[name].title, opts.step ? undefined : { index: i + 1, total: names.length });
    let result: StepResult;
    try {
      result = await STEPS[name].run(ctx);
    } catch (err) {
      if (err instanceof PromptAbortedError) throw err;
      result = err instanceof NeedsInputError ? { step: name, outcome: "needs-input", message: err.message } : { step: name, outcome: "failed", message: (err as Error).message };
    }
    // Fancy mode already showed each app's line; its result is a short tally instead of all of them again.
    ui.result(result.outcome, ui.fancy && result.apps ? appsTally(result.apps) : result.message);
    results.push(result);
    if (name === "node" && result.outcome === "failed") break;
  }
  const { rows, next } = summarize(ctx, results);
  ui.summary({
    steps: results.map((r) => ({ step: r.step, outcome: r.outcome })),
    rows,
    next,
    rerun: `Re-run one step with \`${ctx.cliDisplay} setup --step <${STEP_NAMES.join("|")}>\`. In Claude, the setup_status tool shows the same checks.`,
  });
  ui.outro(results.some((r) => r.outcome === "failed") ? "Finished, with problems above" : "Done");
  return results;
}
