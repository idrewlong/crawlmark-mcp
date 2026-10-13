/**
 * Help text for crawlmark-cli and `crawlmark-mcp <command>` (pure). The top
 * level lists commands in groups with examples; each group's help has the full
 * options. Every line fits in 80 columns. Headings are bold only on a TTY.
 */
import { basename } from "node:path";
import { styleText } from "node:util";

export const HELP_GROUPS = ["init", "setup", "auth", "clients", "competitors", "keywords", "brand", "audit", "check-traffic"] as const;
export type HelpGroup = (typeof HELP_GROUPS)[number];

export function isHelpGroup(name: string | undefined): name is HelpGroup {
  return name !== undefined && (HELP_GROUPS as readonly string[]).includes(name);
}

/** `crawlmark-mcp` when run through the server entry (dist/index.js or the bin), else `crawlmark-cli`. */
export function programName(argv1: string | undefined): "crawlmark-mcp" | "crawlmark-cli" {
  const name = basename(argv1 ?? "").replace(/\.(c|m)?(j|t)s$/, "");
  return name === "index" || name === "crawlmark-mcp" ? "crawlmark-mcp" : "crawlmark-cli";
}

export interface HelpOptions {
  prog: "crawlmark-mcp" | "crawlmark-cli";
  /** Bold headings (stdout is a TTY). */
  bold: boolean;
}

const heading = (text: string, o: HelpOptions) => (o.bold ? styleText("bold", text, { validateStream: false }) : text);

export function topHelp(o: HelpOptions): string {
  const p = o.prog;
  const usage = p === "crawlmark-mcp" ? `Usage: ${p} <command> [options]   (no command: start the MCP server)` : `Usage: ${p} <command> [options]`;
  return [
    "crawlmark: SEO audits and client reports for Claude, Cursor and Codex",
    "",
    usage,
    "",
    heading("Get started", o),
    "  init                  Set up credentials and clients, register your AI apps",
    "  setup --step <name>   Re-run one step: node, provider, dataforseo, ahrefs,",
    "                        semrush, google, psi, discovery or register",
    "  setup status          What's configured and what to do next",
    "  setup migrate --to    Copy your settings to another folder",
    heading("Google", o),
    "  auth login|status|logout",
    heading("Clients", o),
    "  clients, competitors, keywords, brand   Manage clients and their lists",
    heading("Scheduled", o),
    "  audit, check-traffic  Run from cron; exit 2 means alerts",
    "",
    heading("Examples", o),
    "  npx crawlmark-mcp@latest init",
    "  npx crawlmark-mcp setup status",
    '  npx crawlmark-mcp clients add example.com --name "Example Co"',
    "",
    `Run \`${p} help <command>\` for a command's options.`,
  ].join("\n");
}

const GROUP_TEXT: Record<Exclude<HelpGroup, "init">, (p: string) => string[]> = {
  setup: (p) => [
    `Usage: ${p} init [--step <name>] [--dry-run] [--yes]`,
    `       ${p} setup [--step <name>] [--dry-run] [--yes]`,
    `       ${p} setup status [--json] [--only <id,id>] [--refresh]`,
    `       ${p} setup migrate --to <dir> [--force] [--yes] [--dry-run]`,
    "",
    "init, setup",
    "  Guided setup: checks Node (and builds from source), enters and live-checks",
    "  each credential, discovers clients and registers crawlmark with Claude Code,",
    "  Claude Desktop, Cursor and Codex. Re-runnable; each step shows its status",
    "  first and can be skipped. init and setup are the same command.",
    "  --step <name>   Run one step: node, provider, dataforseo, ahrefs, semrush,",
    "                  google, psi, discovery or register. provider picks your SEO",
    "                  data providers and the default one",
    "  --dry-run       Write nothing and register nothing (free checks still run)",
    "  --yes           Accept every default without asking; steps that need input",
    "                  are skipped, and an existing registration is never replaced",
    "",
    "setup status",
    "  The same checks as the setup_status tool: each integration's state and the",
    "  next step.",
    "  --json          Print the report as JSON",
    "  --only <id,id>  Check only these: home, dataforseo, seoprovider, ahrefs,",
    "                  semrush, google, gsc, ga4, tagmanager, psi, chrome, clients",
    "  --refresh       Skip the 60-second cache",
    "",
    "setup migrate",
    "  Copy (never move) .env, config/clients.yaml, data/ and secrets/ from the",
    "  current config home to another folder. Asks first unless --yes.",
    "  --to <dir>      The new config home",
    "  --force         Overwrite files that already exist there",
    "  --yes           Don't ask",
    "  --dry-run       Show what would be copied",
  ],
  auth: (p) => [
    `Usage: ${p} auth login|status|logout`,
    "",
    "  auth login      Sign in to Google in your browser (OAuth mode) and store the",
    "                  token",
    "  auth status     Show the active Google auth mode, account and granted scopes",
    "  auth logout     Revoke the stored Google token and delete it",
  ],
  clients: (p) => [
    `Usage: ${p} clients list [--refresh]`,
    `       ${p} clients add <domain>... [--name <name>]`,
    `       ${p} clients remove <domain>... [--ignore]`,
    `       ${p} clients set <client> [--area <location>] [--niche <text>]`,
    '                [--name <name>] [--brand-terms "a,b"]',
    "                [--provider <dataforseo|ahrefs|semrush|none>]",
    "                [--country <XX|none>]",
    "",
    "clients list",
    "  Show every client. When Google is set up, newly discovered Search Console",
    "  and GA4 domains are added to clients.yaml first.",
    "  --refresh       Re-run discovery instead of using the cache",
    "",
    "clients add",
    "  Add clients by hand (works without Google, e.g. for DataForSEO).",
    "  --name <name>   Display name (only with a single domain)",
    "",
    "clients remove",
    "  Delete clients' entries from clients.yaml.",
    "  --ignore        Hide them for good instead",
    "",
    "clients set",
    '  Set a client\'s details; pass "" to clear one.',
    "  --area <location>    DataForSEO location name, e.g.",
    '                       "Austin,Texas,United States"',
    "  --niche <text>       What the business does",
    "  --name <name>        Display name",
    '  --brand-terms "a,b"  Brand terms (comma-separated; replaces the list). They',
    "                       add to the built-in domain and name matching for the",
    "                       branded split",
    "  --provider <id>      Whose paid data this client uses: dataforseo, ahrefs or",
    "                       semrush; none goes back to the default provider",
    "  --country <XX>       ISO market for Ahrefs/Semrush, e.g. US or GB; none",
    "                       derives it from the location code",
  ],
  competitors: (p) => [
    `Usage: ${p} competitors list <client>`,
    `       ${p} competitors add <client> <domain>... [--note <text>]`,
    `       ${p} competitors remove <client> <domain>...`,
    "",
    "  Manage a client's competitors. URLs and www. forms become bare domains.",
    "  --note <text>   A note saved with the added competitors",
  ],
  keywords: (p) => [
    `Usage: ${p} keywords list <client>`,
    `       ${p} keywords add <client> <keyword>... [--note <text>]`,
    `       ${p} keywords remove <client> <keyword>...`,
    "",
    "  Manage a client's tracked keywords. Quote keywords with spaces.",
    "  --note <text>   A note saved with the added keywords",
  ],
  brand: (p) => [
    `Usage: ${p} brand list <client>`,
    `       ${p} brand add <client> <term>...`,
    `       ${p} brand remove <client> <term>...`,
    `       ${p} brand suggest <client>|--all [--apply]`,
    "                [--min-confidence high|medium] [--paid] [--paid-sparse]",
    "                [--no-paid]",
    "",
    "  list, add and remove manage a client's brand terms (quote terms with",
    "  spaces).",
    "",
    "brand suggest",
    "  Infer brand terms from Search Console (free). For one client, DataForSEO",
    "  (paid, about $0.02 a client) is used when the client has no Search Console",
    "  property, also for sparse data with --paid-sparse, never with --no-paid, and",
    "  never after a Search Console error.",
    "  --all                 Every client. DataForSEO is never used unless --paid",
    "                        or --paid-sparse",
    "  --paid                With --all: clients with no Search Console property",
    "  --paid-sparse         Also clients with under 20 Search Console rows",
    "  --no-paid             Never use DataForSEO",
    "  --apply               Save candidates at or above --min-confidence that",
    "                        match the distinctive part of the client's name",
    "  --min-confidence high|medium",
    '                        Threshold for --apply (default high). AUTO shows "yes"',
    "                        for high candidates that qualify, else why it needs",
    "                        review",
  ],
  audit: (p) => [
    `Usage: ${p} audit --client <domain|slug> [--urls <url,url>] [--dry-run]`,
    `       ${p} audit --all [--dry-run]`,
    "",
    "  Scheduled audit: runs discovery (--all), a fresh run_audit per client (one",
    "  at a time), saves the snapshot and diffs it against the previous one.",
    "  Clients that can't be audited are skipped and reported.",
    "  --client <domain|slug>  One client",
    "  --all                   Every client",
    "  --urls <url,url>        Override the page list (one client only)",
    "  --dry-run               List the pages each client would audit; run nothing",
    "",
    ...SCHEDULED_FOOTER,
  ],
  "check-traffic": (p) => [
    `Usage: ${p} check-traffic --client <domain|slug> | --all [--dry-run]`,
    "",
    "  Compares the last 7 complete Search Console days with the 7 before,",
    "  branded vs non-branded. Free. Clients without Search Console are skipped.",
    "  --client <domain|slug>  One client",
    "  --all                   Every client",
    "  --dry-run               Show the date ranges it would compare; fetch nothing",
    "",
    ...SCHEDULED_FOOTER,
  ],
};

const SCHEDULED_FOOTER = [
  "  Prints JSON to stdout and POSTs a text summary to ALERT_WEBHOOK_URL when",
  "  there are alerts (a new critical or high finding; non-branded clicks down by",
  "  ALERT_TRAFFIC_DROP_PCT and at least ALERT_MIN_CLICKS_LOST).",
  "  Exit code: 0 no alerts, 1 error, 2 alerts.",
];

export function groupHelp(group: HelpGroup, o: HelpOptions): string {
  const lines = GROUP_TEXT[group === "init" ? "setup" : group](o.prog);
  // Section titles (a line with no indent that isn't a usage line) are headings.
  return lines.map((l) => (l && !l.startsWith(" ") && !l.startsWith("Usage:") ? heading(l, o) : l)).join("\n");
}
