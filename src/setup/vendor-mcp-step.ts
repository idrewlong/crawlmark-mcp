/**
 * The `vendor-mcp` step: add Semrush's and Ahrefs' own remote MCP servers to the user's AI apps, for ad-hoc questions.
 * crawlmark never calls these servers and never writes a key for them: sign-in is OAuth in the app. Every change is
 * previewed, asked about and backed up the same way as the crawlmark registration (src/setup/apps.ts), other servers are
 * never touched, and an existing entry with the same URL is "already". A different entry with the same name is replaced
 * only on an explicit yes (the default is no, so --yes never replaces one).
 */
import { existsSync } from "node:fs";
import { backupFile, mergeMcpServersJson, readIfExists, writeConfigWithBackup } from "../lib/claude-config.js";
import {
  claudeCodeVendorArgs,
  codexVendorArgs,
  codexVendorSnippet,
  cursorVendorEntry,
  desktopConnectorSteps,
  parseClaudeVendorGet,
  parseCodexVendorGet,
  planCodexVendorTomlEdit,
  readCodexVendorToml,
  VENDOR_IDS,
  VENDORS,
  type Vendor,
  type VendorId,
  type VendorRegistration,
} from "../lib/vendor-mcp.js";
import { APP_LABELS, cmdLine, detectApps, runApp, type AppId, type AppProbe, type AppStatus, type Note } from "./apps.js";
import { PromptAbortedError, type Choice } from "./prompter.js";
import { uiFor } from "./ui.js";
import { works, type StepResult, type WizardContext } from "./wizard.js";

const OAUTH_NEXT: Record<AppId, string> = {
  "claude-code": "In Claude Code, run /mcp and sign in to {label}.",
  "claude-desktop": "",
  cursor: "Restart Cursor (or reload its MCP servers), then sign in to {label} when it asks.",
  codex: "If Codex needs it, sign in with `codex mcp login {name}`.",
};

function signInNote(app: AppId, v: Vendor): string {
  return OAUTH_NEXT[app].replace("{label}", v.label).replace("{name}", v.name);
}

/** What an existing entry is, for display: its URL or command only (never headers, env or keys). */
function describeExisting(r: { url?: string | undefined; command?: string | undefined; scope?: string | undefined }): string {
  return `${r.url ? `url ${r.url}` : r.command ? `command ${r.command}` : "unknown"}${r.scope ? `  [scope: ${r.scope}]` : ""}`;
}

async function addClaudeCode(ctx: WizardContext, probe: AppProbe, v: Vendor, notes: Note[]): Promise<AppStatus> {
  const addArgs = claudeCodeVendorArgs(v);
  if (!probe.detected) {
    notes.push({ kind: "warn", text: `Claude Code isn't installed (no working \`claude\` command). To add ${v.label} later: ${cmdLine("claude", addArgs)}` });
    return "manual";
  }
  const existing = await ctx.exec("claude", ["mcp", "get", v.name]);
  const add = async (): Promise<AppStatus> => {
    const r = await runApp(ctx, "claude", addArgs);
    notes.push(r.code === 0 ? { kind: "success", text: `Added ${v.label} to Claude Code. ${signInNote("claude-code", v)}` } : { kind: "fail", text: `\`claude mcp add\` for ${v.label} failed (exit ${r.code}).` });
    return r.code === 0 ? "registered" : "failed";
  };
  if (existing.code !== 0) {
    ctx.out(`This adds ${v.label} to Claude Code for all your projects:`);
    ctx.out(`  ${cmdLine("claude", addArgs)}`);
    if (!(await ctx.prompt.confirm(`Add ${v.label}'s MCP server to Claude Code?`, true))) {
      notes.push({ kind: "info", text: `Skipped ${v.label} in Claude Code.` });
      return "skipped";
    }
    if (ctx.dryRun) {
      notes.push({ kind: "info", text: `Dry run: ${v.label} not added to Claude Code.` });
      return "dry-run";
    }
    return add();
  }
  const current = parseClaudeVendorGet(existing.stdout);
  if (!current) {
    ctx.out(`Claude Code has a ${v.name} entry the wizard can't read; leaving it alone.`);
    notes.push({ kind: "warn", text: `To replace it yourself: claude mcp remove ${v.name} -s <scope>, then ${cmdLine("claude", addArgs)}` });
    return "manual";
  }
  if (current.url === v.url) {
    notes.push({ kind: "success", text: `Claude Code: ${v.label} is already added.` });
    return "already";
  }
  const scope = current.scope ?? "user";
  ctx.out(`Claude Code already has a ${v.name} server, with a different setting:`);
  ctx.out(`  current: ${describeExisting(current)}`);
  ctx.out(`  new:     url ${v.url}  [scope: user]`);
  if (!(await ctx.prompt.confirm(`Replace it (claude mcp remove ${v.name} -s ${scope}, then add)?`, false))) {
    notes.push({ kind: "info", text: `Kept the existing ${v.name} entry in Claude Code.` });
    return "skipped";
  }
  if (ctx.dryRun) {
    notes.push({ kind: "info", text: `Dry run: Claude Code's ${v.name} entry not replaced.` });
    return "dry-run";
  }
  const removed = await runApp(ctx, "claude", ["mcp", "remove", v.name, "-s", scope]);
  if (removed.code !== 0) {
    notes.push({ kind: "fail", text: `\`claude mcp remove ${v.name} -s ${scope}\` failed (exit ${removed.code}); nothing was added.` });
    return "failed";
  }
  return add();
}

async function addCursor(ctx: WizardContext, v: Vendor, notes: Note[]): Promise<AppStatus> {
  const app = APP_LABELS.cursor;
  const path = ctx.paths.cursorConfig;
  if (!path) return "manual";
  const entry = cursorVendorEntry(v);
  try {
    const merge = mergeMcpServersJson(readIfExists(path), entry, { app, name: v.name });
    if (!merge.changed) {
      notes.push({ kind: "success", text: `${app} already has ${v.label} (${path}).` });
      return "already";
    }
    const prev = merge.previous as Record<string, unknown> | undefined;
    const lines = [
      merge.otherServers.length ? `Other servers kept unchanged: ${merge.otherServers.join(", ")}` : "No other servers in the file.",
      ...(merge.replaced ? [`Current ${v.name} entry (replaced): ${describeExisting({ url: typeof prev?.url === "string" ? prev.url : undefined, command: typeof prev?.command === "string" ? prev.command : undefined })}`] : []),
      merge.replaced ? `New ${v.name} entry:` : `Adds this ${v.name} entry:`,
      ...JSON.stringify(entry, null, 2).split("\n").map((l) => `    ${l}`),
    ];
    uiFor(ctx).preview(`${app} config: ${path}`, lines);
    const question = merge.replaced ? `Replace the existing ${v.name} entry? (the current file is kept as .bak)` : "Write this change? (the current file is kept as .bak)";
    if (!(await ctx.prompt.confirm(question, !merge.replaced))) {
      notes.push({ kind: "info", text: `Skipped ${v.label} in ${app}.` });
      return "skipped";
    }
    if (ctx.dryRun) {
      notes.push({ kind: "info", text: `Dry run: ${app} config not written.` });
      return "dry-run";
    }
    const backup = writeConfigWithBackup(path, merge.text);
    notes.push({ kind: "success", text: `Added ${v.label} to ${app}'s config${backup ? ` (backup: ${backup})` : ""}. ${signInNote("cursor", v)}` });
    return "registered";
  } catch (err) {
    if (err instanceof PromptAbortedError) throw err;
    notes.push({ kind: "fail", text: `Couldn't update ${app}'s config: ${(err as Error).message}` });
    return "failed";
  }
}

/** Claude Desktop's JSON config only takes local servers; remote ones are added in its Connectors settings. */
function addDesktop(ctx: WizardContext, v: Vendor, notes: Note[]): AppStatus {
  ctx.out(`Claude Desktop adds remote servers in its own settings, not in claude_desktop_config.json. To add ${v.label}:`);
  for (const l of desktopConnectorSteps(v)) ctx.out(`  ${l}`);
  notes.push({ kind: "info", text: `Claude Desktop: add ${v.label} yourself in Settings > Connectors > Add custom connector (URL ${v.url}).` });
  return "manual";
}

function codexRegistrationFor(ctx: WizardContext, v: Vendor, get: { code: number; stdout: string }): VendorRegistration {
  if (get.code === 0) {
    const parsed = parseCodexVendorGet(get.stdout);
    if (parsed) return { kind: "entry", ...parsed };
    return { kind: "unreadable" };
  }
  // A failed get proves nothing by itself: the config file (read, never written here) decides.
  try {
    return readCodexVendorToml(ctx.paths.codexConfig ? readIfExists(ctx.paths.codexConfig) : undefined, v.name);
  } catch {
    return { kind: "unreadable" };
  }
}

async function addCodexCli(ctx: WizardContext, v: Vendor, notes: Note[]): Promise<AppStatus> {
  const addArgs = codexVendorArgs(v);
  const state = codexRegistrationFor(ctx, v, await ctx.exec("codex", ["mcp", "get", v.name, "--json"]));
  const backupConfig = (): string | undefined => (ctx.paths.codexConfig && existsSync(ctx.paths.codexConfig) ? backupFile(ctx.paths.codexConfig) : undefined);
  const add = async (backup?: string): Promise<AppStatus> => {
    const b = backup ?? backupConfig();
    const r = await runApp(ctx, "codex", addArgs);
    notes.push(
      r.code === 0
        ? { kind: "success", text: `Added ${v.label} to Codex${b ? ` (backup: ${b})` : ""}. ${signInNote("codex", v)}` }
        : { kind: "fail", text: `\`codex mcp add\` for ${v.label} failed (exit ${r.code}).` },
    );
    return r.code === 0 ? "registered" : "failed";
  };
  if (state.kind === "absent") {
    ctx.out(`This adds ${v.label} to Codex:`);
    ctx.out(`  ${cmdLine("codex", addArgs)}`);
    if (!(await ctx.prompt.confirm(`Add ${v.label}'s MCP server to Codex?`, true))) {
      notes.push({ kind: "info", text: `Skipped ${v.label} in Codex.` });
      return "skipped";
    }
    if (ctx.dryRun) {
      notes.push({ kind: "info", text: `Dry run: ${v.label} not added to Codex.` });
      return "dry-run";
    }
    return add();
  }
  if (state.kind === "unreadable") {
    ctx.out(`Codex has a ${v.name} entry the wizard can't read; leaving it alone.`);
    notes.push({ kind: "warn", text: `To replace it yourself: codex mcp remove ${v.name}, then ${cmdLine("codex", addArgs)}` });
    return "manual";
  }
  if (state.url === v.url) {
    notes.push({ kind: "success", text: `Codex: ${v.label} is already added.` });
    return "already";
  }
  ctx.out(`Codex already has a ${v.name} server, with a different setting:`);
  ctx.out(`  current: ${describeExisting(state)}`);
  ctx.out(`  new:     url ${v.url}`);
  if (!(await ctx.prompt.confirm(`Replace it (codex mcp remove ${v.name}, then add)?`, false))) {
    notes.push({ kind: "info", text: `Kept the existing ${v.name} entry in Codex.` });
    return "skipped";
  }
  if (ctx.dryRun) {
    notes.push({ kind: "info", text: `Dry run: Codex's ${v.name} entry not replaced.` });
    return "dry-run";
  }
  const backup = backupConfig();
  const removed = await runApp(ctx, "codex", ["mcp", "remove", v.name]);
  if (removed.code !== 0) {
    notes.push({ kind: "fail", text: `\`codex mcp remove ${v.name}\` failed (exit ${removed.code}); nothing was added.` });
    return "failed";
  }
  return add(backup);
}

/** Codex without a working CLI: append the entry to config.toml. A different existing entry is left for the user. */
async function addCodexToml(ctx: WizardContext, v: Vendor, notes: Note[]): Promise<AppStatus> {
  const path = ctx.paths.codexConfig;
  if (!path) return "manual";
  let before: string | undefined;
  try {
    before = readIfExists(path);
  } catch (err) {
    notes.push({ kind: "fail", text: `Couldn't read Codex's config: ${(err as Error).message}` });
    return "failed";
  }
  const plan = planCodexVendorTomlEdit(before, v);
  if (!plan.ok) {
    notes.push({ kind: "warn", text: `Couldn't update Codex's config (${path}): ${plan.reason} To add ${v.label} yourself, paste this into that file:\n${codexVendorSnippet(v).split("\n").map((l) => `    ${l}`).join("\n")}` });
    return "manual";
  }
  if (!plan.changed) {
    notes.push({ kind: "success", text: `Codex already has ${v.label} (${path}).` });
    return "already";
  }
  uiFor(ctx).preview(`Codex config: ${path}`, [
    plan.otherServers.length ? `Other servers kept unchanged: ${plan.otherServers.join(", ")}` : "No other servers in the file.",
    `Adds this ${v.name} entry:`,
    ...codexVendorSnippet(v).split("\n").map((l) => `    ${l}`),
  ]);
  if (!(await ctx.prompt.confirm("Write this change? (the current file is kept as .bak)", true))) {
    notes.push({ kind: "info", text: `Skipped ${v.label} in Codex.` });
    return "skipped";
  }
  if (ctx.dryRun) {
    notes.push({ kind: "info", text: "Dry run: Codex config not written." });
    return "dry-run";
  }
  try {
    const backup = writeConfigWithBackup(path, plan.text);
    notes.push({ kind: "success", text: `Added ${v.label} to Codex's config${backup ? ` (backup: ${backup})` : ""}. Restart Codex. ${signInNote("codex", v)}` });
    return "registered";
  } catch (err) {
    notes.push({ kind: "fail", text: `Couldn't write Codex's config: ${(err as Error).message}` });
    return "failed";
  }
}

/** Vendors whose crawlmark integration works, for pre-ticking when the step is run on its own. */
async function configuredVendors(ctx: WizardContext): Promise<VendorId[]> {
  try {
    const report = await ctx.status(["ahrefs", "semrush"]);
    return VENDOR_IDS.filter((id) => works(id, report.integrations.find((i) => i.id === id)));
  } catch {
    return [];
  }
}

export interface VendorMcpOptions {
  /** True when run with `--step vendor-mcp` or from the menu; false inside the full `init` run, which only asks one question. */
  asked?: boolean;
  /** The full run: the apps the register step just set up. Unset means detect and ask. */
  apps?: AppId[];
}

const names = (ids: readonly VendorId[]) => ids.map((id) => VENDORS[id].label).join(" and ");

export async function stepVendorMcp(ctx: WizardContext, opts: VendorMcpOptions = {}): Promise<StepResult> {
  const step = "vendor-mcp" as const;
  const ui = uiFor(ctx);
  const later = `To add them later: ${ctx.cliDisplay} setup --step vendor-mcp`;
  const selectedProviders = VENDOR_IDS.filter((id) => ctx.providers?.selected?.has(id));
  let vendorIds: VendorId[];
  let noticed = false;

  if (!opts.asked) {
    if (ctx.yes) return { step, outcome: "skipped", message: `Not added (--yes). ${later}` };
    // Plain and CI runs never get this extra question.
    // The register step set up no apps: nothing to add these to, so don't ask.
    if (opts.apps && opts.apps.length === 0) return { step, outcome: "skipped", message: `No apps were set up to add them to. ${later}` };
    if (!ui.fancy || selectedProviders.length === 0) return { step, outcome: "skipped", message: selectedProviders.length ? `Not asked in plain mode. ${later}` : "Not needed (no Semrush or Ahrefs picked)." };
    for (const id of selectedProviders) ctx.out(VENDORS[id].notice);
    noticed = true;
    if (!(await ctx.prompt.confirm(`Also add ${names(selectedProviders)}'s own MCP server to these apps? (optional)`, false))) {
      return { step, outcome: "skipped", message: `Not added. ${later}` };
    }
    vendorIds = selectedProviders;
  } else {
    if (ctx.yes) return { step, outcome: "skipped", message: `--yes adds no vendor MCP servers; run ${ctx.cliDisplay} setup --step vendor-mcp without it.` };
    const defaults = selectedProviders.length ? selectedProviders : await configuredVendors(ctx);
    const choices: Choice<VendorId>[] = VENDOR_IDS.map((id) => ({ value: id, label: VENDORS[id].label, hint: id === "semrush" ? "OAuth, spends your Semrush API units" : "OAuth, spends your Ahrefs API units" }));
    ctx.out("Semrush and Ahrefs each run their own MCP server. Adding one lets your AI app ask it ad-hoc questions. crawlmark's own Semrush and Ahrefs support (API key, caps, reports) is separate and unchanged.");
    vendorIds = ctx.prompt.multiselect
      ? await ctx.prompt.multiselect("Add which vendor MCP servers?", choices, defaults, { summary: `Add: ${defaults.length ? names(defaults) : "none"}. Use these?` })
      : defaults;
    if (!vendorIds.length) return { step, outcome: "skipped", message: "No vendor MCP servers picked." };
  }

  const probes = await ui.spin("Looking for AI apps...", () => detectApps(ctx), { plain: false });
  let apps: AppProbe[];
  if (opts.apps) apps = probes.filter((p) => opts.apps!.includes(p.id));
  else {
    const detected = probes.filter((p) => p.detected).map((p) => p.id);
    const choices: Choice<AppId>[] = probes.map((p) => ({ value: p.id, label: p.label, ...(p.hint ? { hint: p.hint } : {}) }));
    const picked = ctx.prompt.multiselect
      ? await ctx.prompt.multiselect("Add them to which apps?", choices, detected, { summary: `Add to: ${probes.filter((p) => p.detected).map((p) => p.label).join(", ") || "none"} (detected). Use these?` })
      : detected;
    apps = probes.filter((p) => picked.includes(p.id));
  }
  if (!apps.length) return { step, outcome: "skipped", message: "No apps to add them to." };

  const notes: Note[] = [];
  const outcomes: { vendor: VendorId; app: AppId; status: AppStatus }[] = [];
  for (const id of vendorIds) {
    const v = VENDORS[id];
    if (!noticed) {
      ctx.out("");
      ctx.out(v.notice);
    }
    for (const probe of apps) {
      let status: AppStatus;
      if (probe.id === "claude-code") status = await addClaudeCode(ctx, probe, v, notes);
      else if (probe.id === "claude-desktop") status = addDesktop(ctx, v, notes);
      else if (probe.id === "cursor") status = await addCursor(ctx, v, notes);
      else status = probe.codexCli ? await addCodexCli(ctx, v, notes) : await addCodexToml(ctx, v, notes);
      outcomes.push({ vendor: id, app: probe.id, status });
    }
  }
  for (const n of notes) {
    if (!ui.fancy) ctx.out(n.text);
    else ui[n.kind](n.text);
  }
  const failed = outcomes.some((o) => o.status === "failed");
  const added = outcomes.some((o) => o.status === "registered" || o.status === "already");
  return {
    step,
    outcome: failed ? "failed" : added ? "done" : "skipped",
    message: outcomes.map((o) => `${VENDORS[o.vendor].label} in ${APP_LABELS[o.app]}: ${o.status}.`).join(" "),
  };
}
