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
import { claudeCodeAddArgs, describeDesktopChange, describeRegistration, desktopEntry, mergeDesktopConfig, parseClaudeMcpGet, sameRegistration, readIfExists, SERVER_NAME, shellQuote, writeDesktopConfig, type ServerLaunch } from "../lib/claude-config.js";
import { copyFileAtomic } from "../lib/atomic-file.js";
import { readEnvFile, writeEnvFile } from "../lib/env-file.js";
import { expandPath, sourceCheckoutMarker, type HomeSource } from "../lib/home.js";
import { checkDataForSeoCredentials } from "../providers/dataforseo.js";
import { checkPsiKey } from "./checks.js";
import { NeedsInputError, PromptAbortedError, type Prompter } from "./prompter.js";
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
  };
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
}

const MAX_ATTEMPTS = 3;
const stateTag = (s: IntegrationStatus["state"]) => ({ working: "OK", configured: "SET", missing: "MISSING", error: "ERROR" })[s];

// ------------------------------------------------------------------ helpers

async function showStatus(ctx: WizardContext, only: IntegrationId[], opts: { refresh?: boolean } = {}): Promise<Map<IntegrationId, IntegrationStatus>> {
  const map = new Map<IntegrationId, IntegrationStatus>();
  try {
    const report = await ctx.status(only, opts);
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
  if (ctx.dryRun) {
    ctx.out(`Dry run: would set ${keys} in ${ctx.paths.envFile} (mode 0600).`);
    return;
  }
  const r = writeEnvFile(ctx.paths.envFile, updates);
  const changed = [...r.updated, ...r.added];
  ctx.out(changed.length ? `Saved ${changed.join(", ")} to ${ctx.paths.envFile} (mode 0600).` : `${ctx.paths.envFile} already had these values.`);
  const shadowed = Object.keys(updates).filter((k) => ctx.shellEnvKeys.has(k));
  if (shadowed.length) {
    ctx.out(`Warning: your shell (or the MCP client config) also sets ${shadowed.join(", ")}, which overrides .env. Unset it there for the new value to take effect.`);
  }
}

function existingEnv(ctx: WizardContext): Record<string, string> {
  return readEnvFile(ctx.paths.envFile);
}

function cmdLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(shellQuote).join(" ");
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
      ctx.out("Both the API login and the API password are needed.");
      continue;
    }
    ctx.out(`Checking with DataForSEO's free account call (${new URL(baseUrl).hostname})...`);
    const check = await checkDataForSeoCredentials({ login, password, baseUrl }, ctx.fetch);
    if (check.credentialsWork === true) {
      const balance = check.balanceUsd === null ? "unknown" : `$${check.balanceUsd.toFixed(2)}`;
      ctx.out(`Credentials work. Mode: ${check.mode}. Balance: ${balance}.`);
      saveEnv(ctx, { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password, DATAFORSEO_BASE_URL: baseUrl });
      return { step, outcome: "done", message: `DataForSEO works (${check.mode}, balance ${balance}).` };
    }
    if (check.credentialsWork === false) {
      ctx.out("DataForSEO rejected that login and password. Use the API password from the API access page, not your account password.");
      continue;
    }
    ctx.out(`Couldn't reach DataForSEO, so the credentials are untested: ${check.error}`);
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
  printServiceAccountSteps(ctx);
  const dest = join(ctx.paths.home, KEY_FILE_REL);
  const current = env.GOOGLE_APPLICATION_CREDENTIALS ? expandPath(env.GOOGLE_APPLICATION_CREDENTIALS, ctx.paths.userHome, ctx.paths.home) : undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const answer = await ctx.prompt.ask("Path to the service-account JSON key (absolute, or starting with ~)", { default: current && existsSync(current) ? current : undefined });
    if (!answer) {
      ctx.out("A key file path is needed.");
      continue;
    }
    const src = expandPath(answer, ctx.paths.userHome, ctx.paths.cwd);
    if (!existsSync(src) || !statSync(src).isFile()) {
      ctx.out(`No file at ${src}.`);
      continue;
    }
    ctx.out("Checking the key with Google...");
    const check = await ctx.checkKeyFile(src);
    if (!check.ok) {
      ctx.out(`That key didn't work: ${check.problem}`);
      continue;
    }
    ctx.out(`The key works. Service account: ${check.email}`);
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
      ctx.out("That doesn't look like an OAuth client ID (it ends in .apps.googleusercontent.com).");
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
      ctx.out("No key entered.");
      continue;
    }
    ctx.out("Checking the key with one PageSpeed request (can take up to a minute)...");
    const check = await checkPsiKey(key, ctx.fetch);
    if (!check.ok) {
      ctx.out(check.problem);
      continue;
    }
    if (check.note) ctx.out(check.note);
    saveEnv(ctx, { PSI_API_KEY: key });
    return { step, outcome: "done", message: "PageSpeed Insights key works." };
  }
  return { step, outcome: "failed", message: `No working PageSpeed Insights key after ${MAX_ATTEMPTS} attempts.` };
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
    const r = await ctx.cli(["clients", "list", "--refresh"], { inherit: true });
    if (r.code !== 0) return { step, outcome: "failed", message: `Discovery failed (exit ${r.code}); see the output above.` };
  }
  if (await ctx.prompt.confirm("Infer each client's brand terms from Search Console (free, no DataForSEO) and save the high-confidence ones?", true)) {
    if (ctx.dryRun) ctx.out(`Dry run: would run \`${ctx.cliDisplay} brand suggest --all --no-paid --apply\`.`);
    else {
      const r = await ctx.cli(["brand", "suggest", "--all", "--no-paid", "--apply"], { inherit: true });
      if (r.code !== 0) ctx.out(`Brand-term inference failed (exit ${r.code}); you can run it later with \`${ctx.cliDisplay} brand suggest --all --no-paid\`.`);
    }
  }
  return { step, outcome: "done", message: ctx.dryRun ? "Dry run: discovery not run." : "Clients discovered and saved to clients.yaml." };
}

/** Running from an npx cache (`.../_npx/<hash>/node_modules/...`): that path is temporary and must not be registered. */
export function isNpxCache(projectRoot: string): boolean {
  return projectRoot.split(/[\\/]/).includes("_npx");
}

/**
 * How Claude should start the server. CRAWLMARK_HOME is passed when the home isn't
 * the project root. From an npx cache, `npx -y crawlmark-mcp` is registered instead
 * of the cache path. `nodeCommand` is `node` (Claude Code) or an absolute path (Desktop).
 */
export function serverLaunch(ctx: WizardContext, nodeCommand: string): ServerLaunch {
  const env = ctx.paths.homeSource === "project" ? undefined : { CRAWLMARK_HOME: ctx.paths.home };
  if (isNpxCache(ctx.paths.projectRoot)) {
    const npx = nodeCommand === "node" ? "npx" : join(dirname(nodeCommand), process.platform === "win32" ? "npx.cmd" : "npx");
    return { command: npx, args: ["-y", "crawlmark-mcp"], ...(env ? { env } : {}) };
  }
  return { command: nodeCommand, args: ["--disable-warning=ExperimentalWarning", join(ctx.paths.projectRoot, "dist", "index.js")], ...(env ? { env } : {}) };
}

/** Claude Code: register, or replace a different existing registration after showing both. */
async function registerClaudeCode(ctx: WizardContext, messages: string[]): Promise<boolean> {
  const launch = serverLaunch(ctx, "node");
  const addArgs = claudeCodeAddArgs(launch);
  const existing = await ctx.exec("claude", ["mcp", "get", SERVER_NAME]);
  if (existing.code !== 0) {
    ctx.out("Claude Code is installed. This registers crawlmark for all your projects:");
    ctx.out(`  ${cmdLine("claude", addArgs)}`);
    if (!(await ctx.prompt.confirm("Register crawlmark with Claude Code?", true))) {
      messages.push("Skipped Claude Code.");
      return false;
    }
    if (ctx.dryRun) {
      messages.push("Dry run: Claude Code registration not run.");
      return false;
    }
    const r = await ctx.exec("claude", addArgs, { inherit: true });
    messages.push(r.code === 0 ? "Registered with Claude Code." : `\`claude mcp add\` failed (exit ${r.code}).`);
    return r.code === 0;
  }

  const current = parseClaudeMcpGet(existing.stdout);
  if (current && sameRegistration(current, launch)) {
    messages.push(`Claude Code: crawlmark is already registered with this command${current.scope ? ` (${current.scope} scope)` : ""}.`);
    return true;
  }
  if (!current) {
    // Never remove a registration we couldn't read, not even under --yes.
    ctx.out("Claude Code has a crawlmark entry the wizard can't read; leaving it alone.");
    messages.push(`To replace it yourself: claude mcp remove ${SERVER_NAME} -s <scope>, then ${cmdLine("claude", addArgs)}`);
    return false;
  }
  const scope = current.scope ?? "user";
  ctx.out("Claude Code already has a crawlmark server, with a different command:");
  ctx.out(`  current: ${describeRegistration(current)}`);
  ctx.out(`  new:     ${describeRegistration({ ...launch, scope: "user" })}`);
  // Default no, so --yes never removes an existing registration.
  if (!(await ctx.prompt.confirm(`Replace it (claude mcp remove ${SERVER_NAME} -s ${scope}, then add)?`, false))) {
    messages.push("Kept the existing Claude Code registration.");
    return false;
  }
  if (ctx.dryRun) {
    messages.push("Dry run: Claude Code registration not replaced.");
    return false;
  }
  const removed = await ctx.exec("claude", ["mcp", "remove", SERVER_NAME, "-s", scope], { inherit: true });
  if (removed.code !== 0) {
    messages.push(`\`claude mcp remove ${SERVER_NAME} -s ${scope}\` failed (exit ${removed.code}); nothing was added.`);
    return false;
  }
  const r = await ctx.exec("claude", addArgs, { inherit: true });
  messages.push(r.code === 0 ? "Replaced the Claude Code registration." : `Removed the old registration, but \`claude mcp add\` failed (exit ${r.code}). Run: ${cmdLine("claude", addArgs)}`);
  return r.code === 0;
}

export async function stepRegister(ctx: WizardContext): Promise<StepResult> {
  const step = "register";
  const messages: string[] = [];
  let registered = false;
  if (isNpxCache(ctx.paths.projectRoot)) {
    ctx.out("crawlmark is running from a temporary npx cache, so Claude will start it with `npx -y crawlmark-mcp` instead of this path.");
  }

  const addArgs = claudeCodeAddArgs(serverLaunch(ctx, "node"));
  const hasClaude = (await ctx.exec("claude", ["--version"])).code === 0;
  if (hasClaude && (await registerClaudeCode(ctx, messages))) registered = true;

  // Claude Desktop: absolute node path, since Desktop doesn't load your shell's PATH.
  const desktop = ctx.paths.desktopConfig;
  const desktopEntryValue = desktopEntry(serverLaunch(ctx, ctx.node.execPath));
  if (desktop && (existsSync(desktop) || existsSync(dirname(desktop)))) {
    try {
      const before = readIfExists(desktop);
      const merge = mergeDesktopConfig(before, desktopEntryValue);
      if (!merge.changed) messages.push(`Claude Desktop already has this crawlmark entry (${desktop}).`);
      else {
        ctx.out(`Claude Desktop config: ${desktop}`);
        for (const line of describeDesktopChange(merge, desktopEntryValue)) ctx.out(line);
        if (await ctx.prompt.confirm("Write this change? (the current file is kept as .bak)", true)) {
          if (ctx.dryRun) messages.push("Dry run: Claude Desktop config not written.");
          else {
            const backup = writeDesktopConfig(desktop, merge.text);
            registered = true;
            messages.push(`Updated Claude Desktop's config${backup ? ` (backup: ${backup})` : ""}. Restart Claude Desktop to load crawlmark.`);
          }
        } else messages.push("Skipped Claude Desktop.");
      }
    } catch (err) {
      messages.push(`Couldn't update Claude Desktop's config: ${(err as Error).message}`);
    }
  }

  if (!registered) {
    ctx.out("");
    ctx.out("To add crawlmark to a client yourself:");
    ctx.out(`  Claude Code:    ${cmdLine("claude", addArgs)}`);
    ctx.out("  Claude Desktop and other MCP clients (mcpServers config):");
    ctx.out(JSON.stringify({ mcpServers: { [SERVER_NAME]: desktopEntryValue } }, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
  }
  for (const m of messages) ctx.out(m);
  return { step, outcome: registered || ctx.dryRun ? "done" : "skipped", message: messages.join(" ") || "Printed the config snippet." };
}

const STEPS: Record<StepName, { title: string; run: (ctx: WizardContext) => Promise<StepResult> }> = {
  node: { title: "Node and build", run: stepNode },
  dataforseo: { title: "DataForSEO", run: stepDataForSeo },
  google: { title: "Google", run: stepGoogle },
  psi: { title: "PageSpeed Insights key (optional)", run: stepPsi },
  discovery: { title: "Clients", run: stepDiscovery },
  register: { title: "Register with Claude", run: stepRegister },
};

/** Run every step (or one). Steps never throw: failures and missing input are results. Ctrl-C stops the run. */
export async function runWizard(ctx: WizardContext, opts: { step?: StepName } = {}): Promise<StepResult[]> {
  ctx.out(`crawlmark setup. Config home: ${ctx.paths.home}`);
  if (ctx.dryRun) ctx.out("Dry run: nothing will be written or registered. Free read-only checks still run.");
  const names = opts.step ? [opts.step] : STEP_NAMES;
  const results: StepResult[] = [];
  for (const [i, name] of names.entries()) {
    ctx.out("");
    ctx.out(`== ${opts.step ? "" : `${i + 1}/${names.length} `}${STEPS[name].title} ==`);
    let result: StepResult;
    try {
      result = await STEPS[name].run(ctx);
    } catch (err) {
      if (err instanceof PromptAbortedError) throw err;
      result = err instanceof NeedsInputError ? { step: name, outcome: "needs-input", message: err.message } : { step: name, outcome: "failed", message: (err as Error).message };
    }
    ctx.out(`-> ${result.outcome}: ${result.message}`);
    results.push(result);
    if (name === "node" && result.outcome === "failed") break;
  }
  ctx.out("");
  ctx.out("Summary:");
  for (const r of results) ctx.out(`  ${r.step.padEnd(10)} ${r.outcome}`);
  ctx.out(`Re-run one step with \`${ctx.cliDisplay} setup --step <${STEP_NAMES.join("|")}>\`. In Claude, the setup_status tool shows the same checks.`);
  return results;
}
