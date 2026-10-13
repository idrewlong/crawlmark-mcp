<!--
Status: approved (six items approved by the user on 2026-10-13)
Created: 2026-10-13 17:00
Author: my-skills:backend, branch phase-10-polish
Owner: backend
Reasoning: make the CLI installer feel like Vercel's CLI: a menu for returning users, timings, tips, clickable links, "try asking Claude" examples and an update notice. Also SEC-5 from the Phase 9 security review and a test-harness hardening.
Research: none in docs/research/. Facts checked in node_modules on 2026-10-13: fast-wrap-ansi and fast-string-truncated-width (used by @clack/prompts 1.8.1) recognise OSC 8 hyperlinks terminated by BEL.
Supersedes: none

Lives in specs/ (my-skills convention); implementation.md links to it.
-->

## Phase 10: Installer polish

**Status:** built 2026-10-13 on branch `phase-10-polish` (approved 17:00). Owner: backend, for every file below. Builds on Phases 8 and 9. No MCP tool's input or output changes, `--json` shapes are unchanged, and the MCP server makes no new network request.

Goal: `init` should feel like a polished CLI. A returning user gets a menu instead of the whole wizard; every live check says how long it took; results carry a dim tip; links are clickable where the terminal supports it, and the pages a step needs open with Enter; the summary box suggests what to ask Claude (with the user's own clients, read locally); and a daily, opt-out update notice says when a newer version is out.

Non-goals: publishing, new integrations, any change to plain-mode text, Windows-specific testing.

### 10.1 What the user sees

Fancy mode (a TTY, as decided in Phase 8). A returning user (the home has a `.env` and at least one integration works):

```
$ npx crawlmark-mcp@latest init
┌  crawlmark 0.1.0  SEO audits for Claude, Cursor and Codex
●  Config home: ~/.crawlmark
◇  Checking your setup [0.9s]
│  ✔ DataForSEO   ✔ Google   ○ Ahrefs   ○ Semrush   ✔ Clients 11
◆  crawlmark is already set up. What would you like to do?
│  ● Add or change a data provider
│  ○ Change Google sign-in
│  ○ Re-register AI apps
│  ○ Refresh clients
│  ○ Check status
│  ○ Run full setup again
│  ○ Exit
```

A full run (new user, or "Run full setup again"):

```
◇  Checking with DataForSEO's free account call (sandbox.dataforseo.com) [1.2s]
◆  ✔ Credentials work. Mode: sandbox. Balance: $1.00.
│  > To switch between sandbox and live later: npx crawlmark-mcp setup --step dataforseo
...
│  Find the API login and API password at https://app.dataforseo.com/api-access   (an OSC 8 link)
◇  Press Enter to open DataForSEO API access in your browser (or s to skip)
...
╭─ crawlmark is ready ─────────────────────────────────────────────╮
│  ✔ Node   ✔ DataForSEO (default)   ✔ Google   ✔ Clients ...      │
│                                                                  │
│  Next:                                                           │
│    1. Restart Claude Desktop                                     │
│    ...                                                           │
│                                                                  │
│  Try asking Claude:                                              │
│    "Give me the monthly report for Example Co (example.com)"     │
│    "What are the quick wins for example.org?"                    │
│    "Run an audit on example.net and tell me what changed since   │
│     last time"                                                   │
╰──────────────────────────────────────────────────────────────────╯
└  Done in 14s
   Update available 0.1.0 → 0.2.0 · run npx crawlmark-mcp@latest init
```

Plain mode (pipes, `CI`, `TERM=dumb`, `NO_COLOR`, `--yes`) prints exactly what it printed before this phase: no menu, timings, tips, links, browser offers or examples.

### 10.2 Decisions

1. **Returning-user menu** (`src/setup/menu.ts`).
   - Shown only in fancy mode, only for `init` / `setup` without `--step`, and only when `<home>/.env` exists and at least one of DataForSEO, Ahrefs, Semrush or Google works (Semrush counts when its key is accepted with units left, as the wizard already decides).
   - A spinner reads `status(["dataforseo","ahrefs","semrush","google","clients"])` (the same child `setup status --json` the wizard uses). A failed read means no menu: the full wizard runs, as before.
   - A compact status line goes above the select: `✔ DataForSEO   ✔ Google   ○ Ahrefs   ○ Semrush   ✔ Clients 11` (icons per state; the clients cell shows the count only).
   - Choices map to `--step provider`, `google`, `register`, `discovery`, the `setup status` report, the full wizard, or exit. A chosen step runs with the intro already shown (no second banner). Ctrl-C at the menu is the usual cancel (exit 130).
2. **Timings.** `formatElapsed(ms)`: `340ms` under one second, `1.2s` under a minute, `1m 5s` after. The clack spinner's stop line gets a dim `[1.2s]`. The outro becomes `Done in 14s` (whole seconds from 10 s up, one decimal below; `Finished in 14s, with problems above` on failure). `clackUi({ now })` takes the clock (default `performance.now`), so tests are deterministic. plainUi is untouched.
3. **"Try asking Claude"** (`src/setup/try-asking.ts`, pure `tryAskingExamples`).
   - Three prompts: `Give me the monthly report for <name> (<domain>)`, `What are the quick wins for <domain>?`, `Run an audit on <domain> and tell me what changed since last time`. With 1 to 3 clients the prompts cycle over them; the name part is left out when there's no name or it equals the domain.
   - Clients: up to 3, those with a Search Console property first, `ignore: true` skipped, names and domains through `stripControl`, whitespace collapsed and capped at 40 characters.
   - No clients (or an unreadable `clients.yaml`): the same prompts with `example.com` and the hint `Add your own: <cli> clients add <domain>`.
   - Privacy: clients are read only from the local `clients.yaml`, only by the real CLI context, and only when the renderer is fancy (so both streams are TTYs, no `CI`, no `--yes`). The examples are shown in the fancy summary box and never written to a file, log, cache or the network. Plain mode prints nothing new. Tests, docs and fixtures use example.com (plus example.org / example.net) only.
   - Shown on full runs and `--step discovery`.
4. **Clickable links and browser shortcuts.**
   - `supportsHyperlinks(env, isTTY)` (`src/lib/terminal-links.ts`): `FORCE_HYPERLINK=1` / `0` wins; otherwise a TTY and one of `TERM_PROGRAM` in iTerm.app, WezTerm, vscode, ghostty (Apple_Terminal is not), `VTE_VERSION >= 5000`, `WT_SESSION`, `KITTY_WINDOW_ID`.
   - `linkify(text)` runs inside clackUi **after** `stripControl`, so no untrusted escape survives into the output. It wraps each `https://` token whose URL passes `safeLinkUrl` (parses, `https:` only, printable ASCII only, at most 2048 characters) as OSC 8 with a BEL terminator (what clack's wrapper understands). The visible text is always the URL itself, so a link can't point somewhere other than what it says. Trailing punctuation stays outside the link. Only lines, log messages, results and tips are linkified, never config previews or spinner labels.
   - `openUrl(url)`: `open` on macOS, `xdg-open` elsewhere, and on Windows `rundll32 url.dll,FileProtocolHandler <url>` instead of `start`, because `start` is a cmd.exe built-in and cmd.exe would parse `&` in a URL. Spawned with no shell, detached, stdio ignored, never awaited; errors are swallowed and the URL is printed instead. Only URLs passing `safeLinkUrl` are opened.
   - The wizard offers `Press Enter to open <page> in your browser (or s to skip)` before the DataForSEO login, the Ahrefs and Semrush key prompts, the Google OAuth client or service-account steps, and the PageSpeed key. It is offered only when the context has an `openUrl` (the real CLI sets it in fancy mode only) and never in a dry run or under `--yes`.
5. **Tips.** `Ui.tip(text)`: fancy prints a dim `> text` line; plain prints nothing. `tipFor(ctx, result)` (pure) gives one per step result, built on `ctx.cliDisplay` (the Phase 8 `commandPrefix`, so a checkout, a global install and npx each show the right command):
   - google done: `To switch accounts later: <cli> setup --step google`
   - dataforseo done: `To switch between sandbox and live later: <cli> setup --step dataforseo`
   - provider done: `To use another provider for one client: <cli> clients set <domain> --provider <name>`
   - psi skipped: `To add a PageSpeed key later: <cli> setup --step psi`
   - discovery done: `To add a client by hand: <cli> clients add <domain>`
   - register done: `To check everything later: <cli> setup status`
6. **Update notice** (`src/lib/update-check.ts`).
   - When: fancy `init` / `setup` (wizard or menu), and `--help` / `--version` (both entries) when stdout is a TTY. Never when `CI` is set (same rule as the renderer), stdout isn't a TTY, `--json` is passed, or `CRAWLMARK_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` is set to anything but `""`, `0` or `false`.
   - What: `GET https://registry.npmjs.org/crawlmark-mcp/latest`, no added headers, no query, `redirect: "error"`, a 1.5 s `AbortSignal.timeout`, at most 64 KB read. The `version` field must be a semver string.
   - At most once per 24 h: `update-check.json` (`{ checkedAt, latest }`) in `DATA_DIR` for the CLI, or `<home>/data` for `crawlmark-mcp --version` (which loads no config). The timestamp is written after failures too, so an offline machine isn't retried on every run. Nothing is written when the folder's parent doesn't exist (no home is created just for this) or in a dry run.
   - Never throws, never blocks longer than the timeout (the wizard starts it at once and awaits it after the outro), never changes the exit code.
   - Shown only when `latest` is newer by semver; a prerelease `latest` counts only when the current version is a prerelease. Text: `Update available 0.1.0 → x.y.z · run npx crawlmark-mcp@latest init` (dim; on stderr for `--help` / `--version`).
   - The MCP server never imports this module (a test checks the server's import graph).
7. **SEC-5.** `stripControl` (and so `redact()` in `units-billing.ts`) also removes the bidi and invisible format characters U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 and U+FEFF.
8. **Test hardening.** `test/entry.test.ts` `run` uses `killSignal: "SIGKILL"` and a 20 s timeout.
9. **No new runtime dependencies.** Links, opener, semver compare and the registry check are a few dozen lines each on `node:` built-ins.

### 10.3 Files (all backend)

| File | Change |
|---|---|
| `src/lib/terminal-text.ts` | SEC-5 characters in `stripControl` |
| `src/lib/terminal-links.ts` (new) | `supportsHyperlinks`, `safeLinkUrl`, `hyperlink`, `linkify`, `openerCommand`, `openUrl` |
| `src/lib/update-check.ts` (new) | `parseSemver`, `isNewer`, `updateCheckAllowed`, `checkForUpdate`, `updateNotice` |
| `src/setup/ui.ts` | `formatElapsed`, `formatTotal`, `Ui.tip`, `SummaryInfo.tryAsking` (plainUi ignores both) |
| `src/setup/ui-clack.ts` | timings, `Done in Ns`, links, tips, the "Try asking Claude" section |
| `src/setup/try-asking.ts` (new) | `tryAskingExamples` (pure) |
| `src/setup/menu.ts` (new) | `MENU_CHOICES`, `isSetupComplete`, `compactStatusLine`, `returningUserMenu` |
| `src/setup/wizard.ts` | `tipFor`, tips after results, `offerOpen`, `exampleClients` / `openUrl` on the context, `introShown` |
| `src/setup/cli-setup.ts` | menu wiring, `openUrl` and `exampleClients` in fancy mode, update check |
| `src/cli.ts`, `src/index.ts` | update check on `--help` / `--version` |
| `test/entry.test.ts` | kill signal and timeout |
| `test/*.test.ts` | see 10.5 |
| `README.md`, `.env.example`, `docs/launch/blog-outline.md`, `docs/development.md` | the menu, the opt-out variable, the blog items |

### 10.4 Tasks

Each is its own commit.

1. Spec (this file).
2. SEC-5 and the entry-test hardening (independent).
3. Terminal links, the opener and `formatElapsed` (independent).
4. Ui: tips, timings, links and the examples section in clackUi (after 3).
5. Wizard: tips, examples, browser offers, `introShown` (after 4).
6. Returning-user menu and its wiring (after 5).
7. Update notice and its wiring (independent of 4 to 6).
8. Docs.
9. Manual check (Done when).

### 10.5 Test plan

All with injected I/O: no real network, configs, binaries or `.env`.

- `stripControl` / `redact`: each SEC-5 range is removed; ordinary text, emoji and `✔` stay.
- `formatElapsed` / `formatTotal`: 0, 999, 1000, 1234, 59_999, 65_000 ms.
- `supportsHyperlinks`: each env rule, Apple_Terminal false, non-TTY false, `FORCE_HYPERLINK` both ways, `VTE_VERSION` 4999 / 5000.
- `safeLinkUrl` rejects `http:`, `javascript:`, control and bidi characters, spaces, non-ASCII and over-long URLs. `linkify` wraps only safe https tokens, keeps trailing punctuation outside, and leaves text unchanged when disabled; escapes in the input never survive (stripControl first).
- `openerCommand` per platform; `openUrl` refuses unsafe URLs and never uses a shell (spawn injected).
- clackUi with an injected clock: the spinner stop line has `[1.2s]`, the outro reads `Done in 14s`, tips render as `> `, links are OSC 8 only when enabled, and the examples section is in the box.
- plainUi: `tip` prints nothing, and `summary` ignores `tryAsking`; existing wizard tests pass unchanged.
- `tryAskingExamples`: GSC first, ignored skipped, at most 3, name equal to domain collapsed, control characters stripped, long names capped, empty list gives example.com plus the hint.
- `tipFor`: each step's tip uses `ctx.cliDisplay`.
- Wizard: with `openUrl` set and fancy, Enter opens the page and `s` skips; dry run and `--yes` never ask; without `openUrl` nothing is asked (existing scripted tests unchanged).
- Menu: no `.env` gives no menu; nothing working gives no menu; a status read failure gives no menu; each choice maps to its action; the compact line shows icons and the client count.
- Update check: cache fresh means no fetch; stale cache fetches once and rewrites; fetch failure and timeout return nothing and write the timestamp; prereleases; `updateCheckAllowed` for CI, non-TTY, `--json`, both opt-out variables; no write when the parent dir is missing or in a dry run; the request has no query string and no added headers; the server's import graph never reaches `update-check`.
- Plain transcript: `setup --dry-run < /dev/null` and `setup --yes --dry-run` against a temp home print byte-identical output on `main` and on this branch.

**Done when**

- [x] `npm run typecheck`, `npm run build` and `npm test` pass.
- [x] `npm test` leaves the mtimes of `~/.claude.json`, the Claude Desktop config, `~/.cursor/mcp.json`, `~/.codex/config.toml` and `~/.crawlmark` unchanged.
- [x] The plain transcripts above are byte-identical to `main`.
- [x] A fancy `init --dry-run` driven under `script`, with a temp `CRAWLMARK_HOME` holding a `.env` and example.com fixture clients, temp app configs through the overrides, fake `claude` / `codex`, and `FORCE_COLOR=1`, shows the menu with the compact status line, then (on "Run full setup again") spinner timings, tips, OSC 8 links (with `FORCE_HYPERLINK=1`), the "Try asking Claude" section with the fixture clients and `Done in Ns`, and writes nothing (the temp home's file list and mtimes are unchanged; on a brand-new home the status child creates `data/crawlmark.db`, exactly as on `main`).
- [x] `CRAWLMARK_NO_UPDATE_CHECK=1` and `NO_UPDATE_NOTIFIER=1` each stop the registry request; no test makes a real request.
- [x] README mentions the returning-user menu and the opt-out variable; `.env.example` documents `CRAWLMARK_NO_UPDATE_CHECK`; the blog outline lists every new user-visible feature under "Installer polish".
- [x] No real client names or domains appear in code, tests or docs.
